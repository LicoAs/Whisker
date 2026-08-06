import json
import logging
import threading
import time
import io
import wave
from types import SimpleNamespace

import requests
import numpy as np

from whisper_live.backend.base import ServeClientBase


class ServeClientWhisperCppVulkan(ServeClientBase):
    """
    Backend que habla con whisper-server.exe (whisper.cpp + Vulkan) vía HTTP,
    en vez de correr faster_whisper localmente. Implementa la misma interfaz
    que ServeClientFasterWhisper (transcribe_audio, handle_transcription_output,
    set_language, on_segment_finalized, get_segment_language) para que base.py
    no necesite saber con qué backend está hablando.

    Requiere que whisper-server.exe esté corriendo por separado, con -mc 0
    (para no arrastrar contexto entre requests, ver notas del proyecto) y
    -l auto si se quiere auto-detección de idioma.
    """

    SAMPLE_RATE = 16000

    # whisper.cpp, con chunks muy cortos (0.5s, el default compartido con
    # faster_whisper), a veces no devuelve NINGÚN segmento — ni transcripción
    # ni silencio detectado, directamente nada — perdiendo palabras reales.
    # Le damos más audio mínimo por chunk antes de intentar transcribir, sin
    # tocar el valor compartido que usa faster_whisper (que sí funciona bien
    # en 0.5s). A ajustar con más pruebas reales.
    MIN_CHUNK_DURATION_S = 1.5

    # Mismos valores/semántica que en faster_whisper_backend.py, para
    # mantener el comportamiento de auto-detección de idioma idéntico.
    MIN_DURATION_FOR_LANG_DETECTION_S = 1.0
    RELANG_RECHECK_MARGIN_S = 0.7
    LANGUAGE_CANDIDATES = ("es", "en")

    def __init__(
        self,
        websocket,
        task="transcribe",
        language=None,
        client_uid=None,
        server_url="http://127.0.0.1:8080/inference",
        send_last_n_segments=10,
        no_speech_thresh=0.45,
        clip_audio=False,
        same_output_threshold=3,
        translation_queue=None,
        diarization=None,
        word_timestamps=False,
        request_timeout_s=30,
    ):
        """
        Args:
            websocket: conexión WebSocket del cliente (igual que en los otros backends).
            task (str): "transcribe" (whisper.cpp también soporta "translate" si se
                necesita a futuro, pasando task="translate" en el request).
            language (str, optional): idioma fijo pedido por el cliente. None = auto-detect
                restringido a LANGUAGE_CANDIDATES, igual que en faster_whisper_backend.py.
            server_url (str): URL del endpoint /inference de whisper-server.exe.
            request_timeout_s (int): timeout del request HTTP, por si el server se cuelga.
        """
        super().__init__(
            client_uid,
            websocket,
            send_last_n_segments,
            no_speech_thresh,
            clip_audio,
            same_output_threshold,
            translation_queue,
            diarization,
            word_timestamps,
        )
        self.server_url = server_url
        self.task = task
        self.request_timeout_s = request_timeout_s
        self.session = requests.Session()

        self.language = language
        # Idioma que pidió el cliente (None = auto-detect). Nunca se pisa.
        self.language_requested = self.language
        # Idioma detectado para la frase actual (se resetea en on_segment_finalized).
        self.utterance_language = None
        self.utterance_lang_locked_at_duration = None
        self.utterance_lang_rechecked = False

        # threading
        self.trans_thread = threading.Thread(target=self.speech_to_text)
        self.trans_thread.start()
        self.websocket.send(
            json.dumps(
                {
                    "uid": self.client_uid,
                    "message": self.SERVER_READY,
                    "backend": "whisper_cpp_vulkan",
                }
            )
        )

    # ------------------------------------------------------------------
    # Idioma
    # ------------------------------------------------------------------

    def set_language(self, language, probability):
        """
        Equivalente al set_language(info) de faster_whisper_backend.py, pero
        whisper.cpp no nos da un objeto "info" — nos da language + probability
        sueltos en el JSON de respuesta, así que la firma cambia un poco.
        """
        if probability is not None and probability > 0.5:
            self.language = language
            logging.info(f"Detected language {self.language} with probability {probability}")
            self.websocket.send(json.dumps(
                {"uid": self.client_uid, "language": self.language, "language_prob": probability}))

    def on_segment_finalized(self):
        """Igual que en faster_whisper_backend.py: al arrancar frase nueva en
        modo auto-detect, olvidamos el idioma fijado para que se re-detecte."""
        if self.language_requested is None:
            self.utterance_language = None
            self.utterance_lang_locked_at_duration = None
            self.utterance_lang_rechecked = False

    def get_segment_language(self):
        return self.language_requested if self.language_requested is not None else self.utterance_language

    def _pick_restricted_language(self, language_probabilities):
        """
        Igual que detect_restricted_language() en faster_whisper_backend.py,
        pero acá no hace falta una llamada aparte al modelo: whisper.cpp ya
        nos devuelve language_probabilities en la MISMA respuesta que la
        transcripción, así que restringimos sobre ese dato sin gastar un
        segundo request HTTP.
        """
        if not language_probabilities:
            return None
        best_lang = max(
            self.LANGUAGE_CANDIDATES,
            key=lambda lang: language_probabilities.get(lang, 0.0)
        )
        logging.info(
            f"Detección restringida ({'/'.join(self.LANGUAGE_CANDIDATES)}): "
            + " ".join(f"{l}={language_probabilities.get(l, 0.0):.3f}" for l in self.LANGUAGE_CANDIDATES)
            + f" -> {best_lang}"
        )
        return best_lang

    # ------------------------------------------------------------------
    # Llamada HTTP a whisper-server.exe
    # ------------------------------------------------------------------

    @staticmethod
    def _numpy_to_wav_bytes(samples, rate=SAMPLE_RATE):
        """Convierte el array float32 [-1, 1] que usa base.py a bytes WAV
        (PCM 16-bit mono), formato que espera el endpoint /inference."""
        int16_samples = np.clip(samples, -1.0, 1.0)
        int16_samples = (int16_samples * 32767).astype(np.int16)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(rate)
            wf.writeframes(int16_samples.tobytes())
        return buf.getvalue()

    def _call_server(self, input_sample, language):
        """
        Manda el chunk de audio a whisper-server.exe y devuelve el JSON
        parseado, o None si falló (el llamador lo trata como "sin
        resultado", igual que faster_whisper cuando VAD filtra todo).
        """
        chunk_duration_s = len(input_sample) / self.SAMPLE_RATE
        wav_bytes = self._numpy_to_wav_bytes(input_sample)
        files = {"file": ("chunk.wav", wav_bytes, "audio/wav")}
        data = {
            "temperature": "0.0",
            "response_format": "verbose_json",
        }
        # Si no tenemos idioma todavía (auto-detect recién arrancando),
        # no mandamos "language" y dejamos que el server use su default
        # (-l auto, si así se arrancó). Si ya lo tenemos, lo forzamos,
        # igual que faster_whisper fuerza el idioma una vez detectado.
        if language and language != "auto":
            data["language"] = language

        try:
            start = time.time()
            resp = self.session.post(
                self.server_url, files=files, data=data, timeout=self.request_timeout_s
            )
            elapsed = time.time() - start
            resp.raise_for_status()
            logging.info(
                f"[whisper.cpp DEBUG] chunk={chunk_duration_s:.2f}s "
                f"http={elapsed:.3f}s lang_pedido={language}"
            )
            return resp.json()
        except Exception as e:
            logging.error(f"[whisper.cpp] Error llamando a {self.server_url}: {e}")
            return None

    def _parse_segments(self, segments_raw):
        """
        Convierte los dicts JSON de whisper.cpp en objetos con atributos
        (.text, .start, .end, .no_speech_prob, .words), que es lo que
        espera update_segments() en base.py.

        Importante: acá mismo filtramos los segmentos "de puro silencio"
        (no_speech_prob por encima del umbral). faster_whisper nunca llega
        a devolverlos porque el VAD los descarta antes; whisper.cpp en
        cambio SI los devuelve, así que si no los filtramos acá, el chequeo
        de "sin resultado" en base.py (speech_to_text) nunca se dispara y
        SILENCE_FLUSH_CHUNKS deja de funcionar como corresponde.
        """
        parsed = []
        for s in segments_raw:
            words = None
            raw_words = s.get("words")
            if raw_words:
                words = [
                    SimpleNamespace(
                        word=w.get("word", ""),
                        start=w.get("start", 0.0),
                        end=w.get("end", 0.0),
                        probability=w.get("probability", 0.0),
                    )
                    for w in raw_words
                ]
            parsed.append(SimpleNamespace(
                text=s.get("text", ""),
                start=s.get("start", 0.0),
                end=s.get("end", 0.0),
                no_speech_prob=s.get("no_speech_prob", 0.0),
                words=words,
            ))

        total = len(parsed)
        filtered = [p for p in parsed if p.no_speech_prob <= self.no_speech_thresh]
        if total != len(filtered):
            logging.info(
                f"[whisper.cpp DEBUG] filtrados {total - len(filtered)}/{total} segmentos "
                f"por no_speech_prob (thresh={self.no_speech_thresh})"
            )
        return filtered

    # ------------------------------------------------------------------
    # Interfaz que espera base.py
    # ------------------------------------------------------------------

    def transcribe_audio(self, input_sample):
        """
        Equivalente a transcribe_audio() en faster_whisper_backend.py.
        Devuelve una lista de segmentos (posiblemente vacía) con la misma
        forma que espera update_segments() en base.py.
        """
        lang_for_transcribe = (
            self.language_requested
            if self.language_requested is not None
            else self.utterance_language
        )
        sample_duration_s = len(input_sample) / self.SAMPLE_RATE

        response = self._call_server(input_sample, lang_for_transcribe or "auto")
        if response is None:
            # Error de red/servidor: lo tratamos como "sin resultado" en vez
            # de tirar una excepción que rompa el loop de speech_to_text.
            return []

        segments_raw = response.get("segments", [])
        language_probabilities = response.get("language_probabilities")

        # --- Auto-detección restringida (primera vez en la frase) ---
        if lang_for_transcribe is None and self.language_requested is None:
            if sample_duration_s >= self.MIN_DURATION_FOR_LANG_DETECTION_S:
                restricted = self._pick_restricted_language(language_probabilities)
                if restricted is not None:
                    self.utterance_language = restricted
                    self.utterance_lang_locked_at_duration = sample_duration_s

        # --- Re-chequeo de corrección (una sola vez por frase) ---
        elif (
            self.language_requested is None
            and self.utterance_language is not None
            and not self.utterance_lang_rechecked
            and self.utterance_lang_locked_at_duration is not None
        ):
            if sample_duration_s >= self.utterance_lang_locked_at_duration + self.RELANG_RECHECK_MARGIN_S:
                self.utterance_lang_rechecked = True
                # OJO: si ya estamos forzando "language" en el request (porque
                # utterance_language ya estaba fijado), no confirmamos todavía
                # si whisper.cpp sigue mandando language_probabilities completas
                # en ese caso o no — a validar la primera vez que se pruebe esto
                # con audio real. Si vienen vacías, este bloque simplemente no
                # corrige nada (se comporta como si no hubiera re-chequeo).
                rechecked = self._pick_restricted_language(language_probabilities)
                if rechecked is not None and rechecked != self.utterance_language:
                    logging.info(
                        f"Corrigiendo idioma de la frase en curso: "
                        f"{self.utterance_language} -> {rechecked}"
                    )
                    self.utterance_language = rechecked

        # --- Idioma "oficial" de la sesión (para el mensaje al cliente) ---
        if self.language is None:
            detected_lang = response.get("detected_language")
            detected_prob = response.get("detected_language_probability")
            if detected_lang:
                self.set_language(detected_lang, detected_prob)

        return self._parse_segments(segments_raw)

    def handle_transcription_output(self, result, duration):
        """Idéntico a faster_whisper_backend.py."""
        segments = []
        if len(result):
            self.t_start = None
            last_segment = self.update_segments(result, duration)
            segments = self.prepare_segments(last_segment)

        if len(segments):
            self.send_transcription_to_client(segments)