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
    NO_OUTPUT_OVERLAP_S = 1.0

    # Mismos valores/semántica que en faster_whisper_backend.py, para
    # mantener el comportamiento de auto-detección de idioma idéntico.
    MIN_DURATION_FOR_LANG_DETECTION_S = 1.0
    RELANG_RECHECK_MARGIN_S = 0.7
    LANGUAGE_CANDIDATES = ("es", "en")
    # Si el candidato ganador no llega a esta probabilidad, no lo fijamos
    # todavia -- preferimos quedarnos en auto un chunk mas antes que
    # fijar un idioma con casi ninguna confianza real (ej. es=0.02
    # en=0.40 en audio ambiguo justo en una transicion de hablante).
    MIN_LANG_CONFIDENCE = 0.5
    # Umbral de confianza en las palabras generadas (no en si hay habla o
    # no). Calibrado con datos reales: peor caso de habla real correcta
    # visto en pruebas fue -0.67; el caso de basura que queremos filtrar
    # (texto en otro idioma/caracteres random) dio -2.77. Dejamos margen.
    AVG_LOGPROB_THRESH = -1.5
    # Antes lo teníamos más laxo (heredaba no_speech_thresh, 0.68) por la
    # lentitud en CPU con faster_whisper; con GPU hay margen para exigir más
    # confianza antes de confirmar sin pasar por same_output_threshold.
    MULTI_SEGMENT_NO_SPEECH_THRESH = 0.3

    # Frases que Whisper "alucina" con total confianza en tramos de silencio
    # ambiguo (viene de su entrenamiento con videos de YouTube). Ni
    # no_speech_prob ni avg_logprob las distinguen de habla real -- el
    # modelo esta seguro de lo que invento. Se filtran por contenido.
    # Deliberadamente CORTA: frases como "thank you." o "bye." se sacaron
    # de esta lista porque son cosas que alguien puede decir de verdad en
    # una interpretacion real (despedida, agradecimiento) -- filtrarlas a
    # ciegas arriesgaba perder habla real, el mismo error que ya veniamos
    # corrigiendo pero al reves. Solo quedan frases de cierre de video de
    # YouTube, practicamente imposibles de decir de verdad en este contexto.
    HALLUCINATION_PHRASES = {
        "thank you for watching.",
        "thanks for watching.",
        "until the next video.",
        "see you in the next video.",
        "subscribe to my channel.",
        "please subscribe.",
        "gracias por ver el video.",
        "suscribete al canal.",
    }

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
        # Mejor candidato es/en visto hasta ahora para esta frase, aunque
        # todavia no llegue a MIN_LANG_CONFIDENCE. Se usa para restringir
        # el request SIEMPRE a es/en (salvo el primerisimo chunk de la
        # frase, antes de tener ningun dato) -- evita que el modelo se
        # vaya a otros idiomas (griego, portugues, etc.) con audio ambiguo
        # mientras todavia no estamos seguros de cual de los dos es.
        self.utterance_language_provisional = None
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
            self.utterance_language_provisional = None
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
        best_prob = language_probabilities.get(best_lang, 0.0)
        logging.info(
            f"Detección restringida ({'/'.join(self.LANGUAGE_CANDIDATES)}): "
            + " ".join(f"{l}={language_probabilities.get(l, 0.0):.3f}" for l in self.LANGUAGE_CANDIDATES)
            + f" -> {best_lang}"
        )
        if best_prob < self.MIN_LANG_CONFIDENCE:
            logging.info(
                f"[whisper.cpp DEBUG] confianza insuficiente "
                f"({best_prob:.3f} < {self.MIN_LANG_CONFIDENCE}), sigue siendo "
                f"provisional"
            )
        return best_lang, best_prob

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

    def _is_hallucination(self, text):
        """Compara el texto normalizado (minusculas, sin espacios de mas)
        contra la lista de frases conocidas que Whisper alucina."""
        normalized = text.strip().lower()
        return normalized in self.HALLUCINATION_PHRASES

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
                avg_logprob=s.get("avg_logprob"),
                words=words,
            ))

        # DEBUG TEMPORAL: para calibrar un futuro filtro anti-alucinaciones
        # (ej. "Thank you very much." inventado en tramos de silencio real),
        # logueamos no_speech_prob y avg_logprob de cada segmento. Sacar esta
        # linea una vez que tengamos el umbral calibrado con datos reales.
        for p in parsed:
            logging.info(
                f"[whisper.cpp DEBUG] segmento texto={p.text!r} "
                f"no_speech_prob={p.no_speech_prob:.4f} "
                f"avg_logprob={p.avg_logprob}"
            )

        before = len(parsed)
        parsed = [p for p in parsed if not self._is_hallucination(p.text)]
        if len(parsed) != before:
            logging.info(
                f"[whisper.cpp DEBUG] descartados {before - len(parsed)} "
                f"segmento(s) por lista negra de alucinaciones"
            )

        # Volvemos a filtrar por no_speech_prob (lo habiamos sacado porque
        # descartaba habla real de golpe) -- ahora que base.py deja un margen
        # de cola sin consumir cuando algo se clasifica como silencio
        # (SILENCE_TAIL_MARGIN_S), es seguro filtrar de nuevo: sin este
        # filtro, un segmento de baja confianza (ej "you" con
        # no_speech_prob=0.94) nunca queda vacio para speech_to_text(),
        # nunca entra a la rama de silencio, y el chunk se queda creciendo
        # sin limite (se vieron casos de 14s+ pegados en la misma alucinacion).
        before = len(parsed)
        parsed = [p for p in parsed if p.no_speech_prob <= self.no_speech_thresh]
        if len(parsed) != before:
            logging.info(
                f"[whisper.cpp DEBUG] descartados {before - len(parsed)} "
                f"segmento(s) por no_speech_prob (thresh={self.no_speech_thresh})"
            )

        # Filtro adicional por avg_logprob: agarra basura que no_speech_prob
        # no detecta -- ej. texto en otro idioma/caracteres random que
        # aparece sobre todo en el primerisimo chunk de una frase (el unico
        # momento en que mandamos "auto" puro, sin restringir a es/en).
        # Vimos un caso real con avg_logprob=-2.77 y no_speech_prob=0.0 (no
        # filtrado por el chequeo de arriba); el peor caso de habla real
        # correcta que vimos en pruebas fue -0.67, asi que hay margen amplio.
        before = len(parsed)
        parsed = [
            p for p in parsed
            if p.avg_logprob is None or p.avg_logprob >= self.AVG_LOGPROB_THRESH
        ]
        if len(parsed) != before:
            logging.info(
                f"[whisper.cpp DEBUG] descartados {before - len(parsed)} "
                f"segmento(s) por avg_logprob (thresh={self.AVG_LOGPROB_THRESH})"
            )

        return parsed

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
            else (self.utterance_language or self.utterance_language_provisional)
        )
        sample_duration_s = len(input_sample) / self.SAMPLE_RATE

        response = self._call_server(input_sample, lang_for_transcribe or "auto")
        if response is None:
            # Error de red/servidor: lo tratamos como "sin resultado" en vez
            # de tirar una excepción que rompa el loop de speech_to_text.
            return []

        segments_raw = response.get("segments", [])
        language_probabilities = response.get("language_probabilities")

        # --- Auto-detección restringida (todavia no fijamos idioma) ---
        if self.utterance_language is None and self.language_requested is None:
            if language_probabilities:
                best_lang, best_prob = self._pick_restricted_language(language_probabilities)
                # Guardamos el mejor candidato SIEMPRE, aunque no llegue a
                # la confianza minima -- asi el proximo request ya sale
                # restringido a es/en en vez de mandarse en auto puro.
                self.utterance_language_provisional = best_lang
                if best_prob >= self.MIN_LANG_CONFIDENCE:
                    self.utterance_language = best_lang
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
                if language_probabilities:
                    rechecked, _ = self._pick_restricted_language(language_probabilities)
                    if rechecked != self.utterance_language:
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