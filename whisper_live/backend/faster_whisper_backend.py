import os
import json
import logging
import threading
import time

# Make the ROCm 6.2 runtime visible to Python before importing CTranslate2.
# Keep the directory handle alive for the lifetime of the process.
ROCM_BIN = os.environ.get(
    "ROCM_BIN",
    r"C:\Program Files\AMD\ROCm\6.2\bin",
)
_ROCM_DLL_DIRECTORY = None

if os.name == "nt" and os.path.isdir(ROCM_BIN):
    os.environ["PATH"] = ROCM_BIN + os.pathsep + os.environ.get("PATH", "")
    _ROCM_DLL_DIRECTORY = os.add_dll_directory(ROCM_BIN)

import ctranslate2
import torch
from huggingface_hub import snapshot_download
from silero_vad import get_speech_timestamps, load_silero_vad

from whisper_live.transcriber.transcriber_faster_whisper import WhisperModel
from whisper_live.backend.base import ServeClientBase


class ServeClientFasterWhisper(ServeClientBase):
    NO_OUTPUT_SLEEP_S = 0.10
    SINGLE_MODEL = None
    SINGLE_MODEL_LOCK = threading.Lock()
    BATCH_WORKER = None

    # Experimental external Silero gate. It runs BEFORE language detection
    # and Faster-Whisper. If it decides there is not enough speech yet,
    # transcribe_audio() returns None and base.py handles it as no_output.
    # The stable base currently preserves 0.5 s after no_output, which acts
    # as the pre-roll for the next pass.
    VAD_SPEECH_PROB_THRESHOLD = 0.6
    MIN_SPEECH_DURATION_IN_CHUNK_S = 0.3
    _VAD_MODEL = None
    _VAD_MODEL_LOCK = threading.Lock()

    def __init__(
        self,
        websocket,
        task="transcribe",
        device=None,
        language=None,
        client_uid=None,
        model="small.en",
        initial_prompt=None,
        vad_parameters=None,
        use_vad=True,
        single_model=False,
        send_last_n_segments=10,
        no_speech_thresh=0.45,
        clip_audio=False,
        same_output_threshold=3,
        cache_path="~/.cache/whisper-live/",
        translation_queue=None,
        hotwords=None,
        diarization=None,
        word_timestamps=False,
    ):
        """
        Initialize a ServeClient instance.
        The Whisper model is initialized based on the client's language and device availability.
        The transcription thread is started upon initialization. A "SERVER_READY" message is sent
        to the client to indicate that the server is ready.

        Args:
            websocket (WebSocket): The WebSocket connection for the client.
            task (str, optional): The task type, e.g., "transcribe". Defaults to "transcribe".
            device (str, optional): The device type for Whisper, "cuda" or "cpu". Defaults to None.
            language (str, optional): The language for transcription. Defaults to None.
            client_uid (str, optional): A unique identifier for the client. Defaults to None.
            model (str, optional): The whisper model size. Defaults to 'small.en'
            initial_prompt (str, optional): Prompt for whisper inference. Defaults to None.
            single_model (bool, optional): Whether to instantiate a new model for each client connection. Defaults to False.
            send_last_n_segments (int, optional): Number of most recent segments to send to the client. Defaults to 10.
            no_speech_thresh (float, optional): Segments with no speech probability above this threshold will be discarded. Defaults to 0.45.
            clip_audio (bool, optional): Whether to clip audio with no valid segments. Defaults to False.
            same_output_threshold (int, optional): Number of repeated outputs before considering it as a valid segment. Defaults to 10.

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
        self.cache_path = cache_path
        self.model_sizes = [
            "tiny", "tiny.en", "base", "base.en", "small", "small.en",
            "medium", "medium.en", "large-v2", "large-v3", "distil-small.en",
            "distil-medium.en", "distil-large-v2", "distil-large-v3",
            "large-v3-turbo", "turbo"
        ]

        self.model_size_or_path = model
        self.language = "en" if self.model_size_or_path.endswith("en") else language
        # Idioma que pidió el cliente (None = auto-detect). Nunca se pisa.
        self.language_requested = self.language
        # Idioma detectado para la FRASE actual (el buffer desde el último
        # reset). Se resetea a None cada vez que arranca una frase nueva
        # (ver on_segment_finalized), así no queda pegado a un idioma viejo,
        # pero tampoco se re-detecta en cada chunk parcial de la misma frase.
        self.utterance_language = None
        # Cuánto audio (segundos) había cuando se fijó utterance_language
        # por primera vez, y si ya se usó la re-chequeada de corrección.
        # Sirven para permitir UNA sola corrección con más contexto más
        # adelante en la misma frase (ver transcribe_audio), por si la
        # primera detección se equivocó con una palabra corta/ambigua.
        self.utterance_lang_locked_at_duration = None
        self.utterance_lang_rechecked = False

        # Diagnostic-only latency marker. When Silero first sees enough speech
        # for the current utterance, we estimate when that speech actually
        # started inside the buffered chunk. The marker is cleared after the
        # first transcription payload is sent to the client.
        self._latency_pending_speech_started_at = None

        self.task = task
        self.initial_prompt = initial_prompt
        self.vad_parameters = vad_parameters or {"threshold": 0.3}
        self.hotwords = hotwords

        # Detect the GPU through CTranslate2 itself. PyTorch CUDA detection is
        # not valid for this Windows ROCm build, while CTranslate2 reports the
        # RX 6700 XT as a CUDA-compatible device through its HIP backend.
        if device is None:
            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"

        self.compute_type = "float16" if device == "cuda" else "int8"

        if self.model_size_or_path is None:
            return

        logging.info(
            "Using CTranslate2 device=%s with precision=%s "
            "(ROCm devices detected=%d)",
            device,
            self.compute_type,
            ctranslate2.get_cuda_device_count(),
        )
    
        try:
            if single_model:
                if ServeClientFasterWhisper.SINGLE_MODEL is None:
                    self.create_model(device)
                    ServeClientFasterWhisper.SINGLE_MODEL = self.transcriber
                else:
                    self.transcriber = ServeClientFasterWhisper.SINGLE_MODEL
            else:
                self.create_model(device)
        except Exception as e:
            logging.error(f"Failed to load model: {e}")
            self.websocket.send(json.dumps({
                "uid": self.client_uid,
                "status": "ERROR",
                "message": f"Failed to load model: {str(self.model_size_or_path)}"
            }))
            self.websocket.close()
            return

        self.use_vad = use_vad

        # threading
        self.trans_thread = threading.Thread(target=self.speech_to_text)
        self.trans_thread.start()
        self.websocket.send(
            json.dumps(
                {
                    "uid": self.client_uid,
                    "message": self.SERVER_READY,
                    "backend": "faster_whisper"
                }
            )
        )

    def create_model(self, device):
        """
        Instantiates a new model, sets it as the transcriber. If model is a huggingface model_id
        then it is automatically converted to ctranslate2(faster_whisper) format.
        """
        model_ref = self.model_size_or_path

        if model_ref in self.model_sizes:
            model_to_load = model_ref
        else:
            logging.info(f"Model not in model_sizes")
            if os.path.isdir(model_ref) and ctranslate2.contains_model(model_ref):
                model_to_load = model_ref
            else:
                local_snapshot = snapshot_download(
                    repo_id = model_ref,
                    repo_type = "model",
                )
                if ctranslate2.contains_model(local_snapshot):
                    model_to_load = local_snapshot
                else:
                    cache_root = os.path.expanduser(os.path.join(self.cache_path, "whisper-ct2-models/"))
                    os.makedirs(cache_root, exist_ok=True)
                    safe_name = model_ref.replace("/", "--")
                    ct2_dir = os.path.join(cache_root, safe_name)

                    if not ctranslate2.contains_model(ct2_dir):
                        logging.info(f"Converting '{model_ref}' to CTranslate2 @ {ct2_dir}")
                        ct2_converter = ctranslate2.converters.TransformersConverter(
                            local_snapshot, 
                            copy_files=["tokenizer.json", "preprocessor_config.json"]
                        )
                        ct2_converter.convert(
                            output_dir=ct2_dir,
                            quantization=self.compute_type,
                            force=False,  # skip if already up-to-date
                        )
                    model_to_load = ct2_dir

        logging.info(f"Loading model: {model_to_load}")
        self.transcriber = WhisperModel(
            model_to_load,
            device=device,
            compute_type=self.compute_type,
            local_files_only=False,
        )

    def set_language(self, info):
        """
        Updates the language attribute based on the detected language information.

        Args:
            info (object): An object containing the detected language and its probability. This object
                        must have at least two attributes: `language`, a string indicating the detected
                        language, and `language_probability`, a float representing the confidence level
                        of the language detection.
        """
        if info.language_probability > 0.5:
            self.language = info.language
            logging.info(f"Detected language {self.language} with probability {info.language_probability}")
            self.websocket.send(json.dumps(
                {"uid": self.client_uid, "language": self.language, "language_prob": info.language_probability}))

    def on_segment_finalized(self):
        """
        Arrancó una frase nueva (el buffer avanzó). Si el cliente pidió
        auto-detect, olvidamos el idioma detectado de la frase anterior
        para que la frase nueva se detecte de cero.
        """
        if self.language_requested is None:
            self.utterance_language = None
            self.utterance_lang_locked_at_duration = None
            self.utterance_lang_rechecked = False

    def get_segment_language(self):
        return self.language_requested if self.language_requested is not None else self.utterance_language        

    # Duración mínima (en segundos) de audio acumulado antes de confiar en
    # detect_restricted_language(). Es un umbral aparte de MIN_CHUNK_DURATION_S
    # (que solo controla cada cuánto se intenta procesar/chequear silencio):
    # bajar ese umbral general hizo que la detección de idioma se disparara
    # con muy poco audio (a veces 0.5s), y con tan poca info se equivoca
    # más seguido entre es/en. Este valor mantiene la detección tan confiable
    # como antes, sin perder la respuesta rápida del resto del pipeline.
    MIN_DURATION_FOR_LANG_DETECTION_S = 1.0
    SAMPLE_RATE = 16000
    # Cuántos segundos más de audio (por encima del punto donde se fijó el
    # idioma por primera vez) esperamos antes de re-chequear una sola vez.
    # Evita quedar pegado a una detección inicial equivocada (ej. una
    # palabra corta como "sí" escuchada como "see") cuando ya hay más
    # contexto disponible que la desmiente.
    RELANG_RECHECK_MARGIN_S = 0.7

    @classmethod
    def _get_external_vad_model(cls):
        """Load the external Silero VAD model once per process."""
        if cls._VAD_MODEL is None:
            with cls._VAD_MODEL_LOCK:
                if cls._VAD_MODEL is None:
                    cls._VAD_MODEL = load_silero_vad()
        return cls._VAD_MODEL

    def _get_external_vad_speech_stats(self, input_sample):
        """Return total speech duration and first speech start detected by Silero."""
        wav = torch.as_tensor(input_sample, dtype=torch.float32)
        timestamps = get_speech_timestamps(
            wav,
            self._get_external_vad_model(),
            sampling_rate=self.SAMPLE_RATE,
            threshold=self.VAD_SPEECH_PROB_THRESHOLD,
            return_seconds=True,
        )

        speech_duration_s = sum(ts["end"] - ts["start"] for ts in timestamps)
        first_speech_start_s = timestamps[0]["start"] if timestamps else None

        return speech_duration_s, first_speech_start_s

    def _external_vad_should_run(self, input_sample):
        """
        Diagnostic gate.

        Fail-open by design: if Silero itself errors, Faster-Whisper still runs.
        """
        chunk_duration_s = len(input_sample) / self.SAMPLE_RATE
        vad_t0 = time.perf_counter()

        try:
            speech_duration_s, first_speech_start_s = self._get_external_vad_speech_stats(
                input_sample
            )
        except Exception as e:
            vad_elapsed_s = time.perf_counter() - vad_t0
            logging.warning(
                "[VAD] chunk=%.3fs decision=RUN reason=error vad=%.3fs error=%s",
                chunk_duration_s,
                vad_elapsed_s,
                e,
            )
            return True

        vad_elapsed_s = time.perf_counter() - vad_t0
        should_run = speech_duration_s >= self.MIN_SPEECH_DURATION_IN_CHUNK_S

        if (
            should_run
            and first_speech_start_s is not None
            and self._latency_pending_speech_started_at is None
        ):
            # The chunk already existed when this VAD pass started. Estimate
            # the wall-clock speech onset by rewinding from the chunk end to
            # Silero's first detected speech timestamp.
            seconds_from_speech_start_to_chunk_end = max(
                0.0,
                chunk_duration_s - first_speech_start_s,
            )
            self._latency_pending_speech_started_at = (
                vad_t0 - seconds_from_speech_start_to_chunk_end
            )
            logging.info(
                "[LATENCY] speech_start_detected chunk=%.3fs first_speech_at=%.3fs",
                chunk_duration_s,
                first_speech_start_s,
            )

        logging.info(
            "[VAD] chunk=%.3fs speech=%.3fs decision=%s threshold=%.2f "
            "min_speech=%.3fs vad=%.3fs",
            chunk_duration_s,
            speech_duration_s,
            "RUN" if should_run else "SKIP",
            self.VAD_SPEECH_PROB_THRESHOLD,
            self.MIN_SPEECH_DURATION_IN_CHUNK_S,
            vad_elapsed_s,
        )
        return should_run

    def detect_restricted_language(self, input_sample, candidates=("es", "en")):
        """
        Restringe la auto-detección de idioma a un conjunto reducido de
        candidatos (por default español e inglés), en vez de dejar que
        Whisper elija libremente entre los ~100 idiomas que conoce. Evita
        falsos positivos (japonés, árabe, etc.) en audio corto o ambiguo,
        que es donde más se nota el error de la detección sin restringir.

        Devuelve el código del candidato con mayor probabilidad, o None
        si no se pudo determinar (en ese caso se sigue con el
        comportamiento normal de auto-detect sin restricción, como
        fallback seguro).
        """
        detect_t0 = time.perf_counter()
        input_duration_s = len(input_sample) / self.SAMPLE_RATE
        try:
            _, _, all_language_probs = self.transcriber.detect_language(input_sample)
        except Exception as e:
            detect_elapsed_s = time.perf_counter() - detect_t0
            logging.info(
                "[TIMING] detect_language input=%.3fs took=%.3fs error=yes",
                input_duration_s,
                detect_elapsed_s,
            )
            logging.warning(f"No se pudo restringir la detección de idioma, sigo sin restricción: {e}")
            return None

        detect_elapsed_s = time.perf_counter() - detect_t0
        logging.info(
            "[TIMING] detect_language input=%.3fs took=%.3fs error=no",
            input_duration_s,
            detect_elapsed_s,
        )

        if not all_language_probs:
            return None

        probs_by_lang = dict(all_language_probs)
        best_lang = max(candidates, key=lambda lang: probs_by_lang.get(lang, 0.0))
        logging.info(
            f"Detección restringida ({'/'.join(candidates)}): "
            f"es={probs_by_lang.get('es', 0.0):.3f} en={probs_by_lang.get('en', 0.0):.3f} -> {best_lang}"
        )
        return best_lang

    def transcribe_audio(self, input_sample):
        """
        Transcribes the provided audio sample using the configured transcriber instance.

        If the language has not been set, it updates the session's language based on the transcription
        information.

        Args:
            input_sample (np.array): The audio chunk to be transcribed. This should be a NumPy
                                    array representing the audio data.

        Returns:
            The transcription result from the transcriber. The exact format of this result
            depends on the implementation of the `transcriber.transcribe` method but typically
            includes the transcribed text.
        """
        total_t0 = time.perf_counter()
        input_duration_s = len(input_sample) / self.SAMPLE_RATE

        # External Silero gate. On SKIP we intentionally return None before
        # restricted language detection and before Faster-Whisper. base.py's
        # current no_output handling keeps the last 0.5 s, so the next pass
        # re-hears the boundary instead of losing the first word.
        if self.use_vad and not self._external_vad_should_run(input_sample):
            return None

        # Si el cliente pidió un idioma fijo, se usa siempre ese.
        # Si pidió auto-detect (language_requested is None), usamos el
        # idioma ya detectado para ESTA frase si lo tenemos; si la frase
        # recién arranca (utterance_language todavía en None), mandamos
        # None para que faster-whisper lo detecte de cero.
        lang_for_transcribe = (
            self.language_requested
            if self.language_requested is not None
            else self.utterance_language
        )

        # Si estamos en auto-detect y todavía no detectamos el idioma de
        # esta frase (recién arrancó el buffer), restringimos la detección
        # a español/inglés en vez de dejar que corra el auto-detect normal
        # de Whisper, que compite entre todos los idiomas que conoce.
        # OJO: solo lo hacemos si ya hay suficiente audio acumulado
        # (MIN_DURATION_FOR_LANG_DETECTION_S) — con muy poco audio la
        # detección es poco confiable y forzar un idioma equivocado hace
        # que Whisper "traduzca" en vez de transcribir tal cual. Si todavía
        # no hay suficiente, esta vuelta se procesa sin idioma forzado
        # (auto-detect normal de Whisper) y se reintenta la próxima vuelta
        # con más audio.
        # Si esta vuelta detecta un idioma restringido, lo usamos para ESTA
        # inferencia pero no lo fijamos todavía como idioma de la frase.
        # Solo se confirma después si la inferencia realmente devuelve voz.
        # Así un bloque de silencio no puede dejar preparado un idioma falso
        # para la intervención siguiente.
        pending_utterance_language = None
        pending_utterance_lang_duration = None

        if lang_for_transcribe is None and self.language_requested is None:
            sample_duration_s = len(input_sample) / self.SAMPLE_RATE
            if sample_duration_s >= self.MIN_DURATION_FOR_LANG_DETECTION_S:
                restricted_lang = self.detect_restricted_language(input_sample)
                if restricted_lang is not None:
                    lang_for_transcribe = restricted_lang
                    pending_utterance_language = restricted_lang
                    pending_utterance_lang_duration = sample_duration_s

        # Re-chequeo de corrección (una sola vez por frase): si ya fijamos
        # un idioma pero con poco audio pudo haberse equivocado (ej. una
        # palabra corta mal escuchada), y ahora hay bastante más contexto
        # acumulado, volvemos a preguntar. Si el resultado cambia, corregimos
        # el rumbo para el resto de la frase en vez de seguir traduciendo mal.
        elif (
            self.language_requested is None
            and self.utterance_language is not None
            and not self.utterance_lang_rechecked
            and self.utterance_lang_locked_at_duration is not None
        ):
            sample_duration_s = len(input_sample) / self.SAMPLE_RATE
            if sample_duration_s >= self.utterance_lang_locked_at_duration + self.RELANG_RECHECK_MARGIN_S:
                self.utterance_lang_rechecked = True
                rechecked_lang = self.detect_restricted_language(input_sample)
                if rechecked_lang is not None and rechecked_lang != self.utterance_language:
                    logging.info(f"Corrigiendo idioma de la frase en curso: {self.utterance_language} -> {rechecked_lang}")
                    self.utterance_language = rechecked_lang
                    lang_for_transcribe = rechecked_lang

        # Batch inference path: submit to central queue and wait
        if ServeClientFasterWhisper.BATCH_WORKER is not None:
            from whisper_live.batch_inference import BatchRequest
            request = BatchRequest(
                audio=input_sample,
                language=lang_for_transcribe,
                task=self.task,
                initial_prompt=self.initial_prompt,
                use_vad=self.use_vad,
                vad_parameters=self.vad_parameters if self.use_vad else None,
                word_timestamps=self.word_timestamps,
                client_uid=self.client_uid,
            )
            batch_t0 = time.perf_counter()
            ServeClientFasterWhisper.BATCH_WORKER.submit(request)
            request.future.wait(timeout=30)
            batch_elapsed_s = time.perf_counter() - batch_t0
            if request.error:
                raise request.error
            if (
                pending_utterance_language is not None
                and request.result is not None
                and len(request.result) > 0
            ):
                self.utterance_language = pending_utterance_language
                self.utterance_lang_locked_at_duration = pending_utterance_lang_duration
                logging.info(
                    "Idioma de frase confirmado tras voz: %s (%.3fs)",
                    self.utterance_language,
                    self.utterance_lang_locked_at_duration,
                )
            elif pending_utterance_language is not None:
                logging.info(
                    "Idioma candidato descartado por no_output: %s",
                    pending_utterance_language,
                )

            if self.language is None and request.info is not None:
                self.set_language(request.info)

            total_elapsed_s = time.perf_counter() - total_t0
            logging.info(
                "[TIMING] transcribe input=%.3fs lang=%s call=%.3fs total=%.3fs mode=batch",
                input_duration_s,
                lang_for_transcribe or "auto",
                batch_elapsed_s,
                total_elapsed_s,
            )
            return request.result

        # Original lock-based path (backward compatible)
        lock_wait_s = 0.0
        if ServeClientFasterWhisper.SINGLE_MODEL:
            lock_t0 = time.perf_counter()
            ServeClientFasterWhisper.SINGLE_MODEL_LOCK.acquire()
            lock_wait_s = time.perf_counter() - lock_t0

        transcribe_t0 = time.perf_counter()
        try:
            result, info = self.transcriber.transcribe(
                input_sample,
                initial_prompt=self.initial_prompt,
                language=lang_for_transcribe,
                task=self.task,
                vad_filter=self.use_vad,
                vad_parameters=self.vad_parameters if self.use_vad else None,
                hotwords=self.hotwords,
                word_timestamps=self.word_timestamps)
        finally:
            transcribe_elapsed_s = time.perf_counter() - transcribe_t0
            if ServeClientFasterWhisper.SINGLE_MODEL:
                ServeClientFasterWhisper.SINGLE_MODEL_LOCK.release()

        if (
            pending_utterance_language is not None
            and result is not None
            and len(result) > 0
        ):
            self.utterance_language = pending_utterance_language
            self.utterance_lang_locked_at_duration = pending_utterance_lang_duration
            logging.info(
                "Idioma de frase confirmado tras voz: %s (%.3fs)",
                self.utterance_language,
                self.utterance_lang_locked_at_duration,
            )
        elif pending_utterance_language is not None:
            logging.info(
                "Idioma candidato descartado por no_output: %s",
                pending_utterance_language,
            )

        if self.language is None and info is not None:
            self.set_language(info)

        total_elapsed_s = time.perf_counter() - total_t0
        logging.info(
            "[TIMING] transcribe input=%.3fs lang=%s call=%.3fs total=%.3fs lock_wait=%.3fs mode=direct",
            input_duration_s,
            lang_for_transcribe or "auto",
            transcribe_elapsed_s,
            total_elapsed_s,
            lock_wait_s,
        )
        return result

    def handle_transcription_output(self, result, duration):
        """
        Handle the transcription output, updating the transcript and sending data to the client.

        Args:
            result (str): The result from whisper inference i.e. the list of segments.
            duration (float): Duration of the transcribed audio chunk.
        """
        latency_speech_started_at = self._latency_pending_speech_started_at

        segments = []
        if len(result):
            self.t_start = None
            last_segment = self.update_segments(result, duration)
            segments = self.prepare_segments(last_segment)

        if len(segments):
            self.send_transcription_to_client(segments)

            if latency_speech_started_at is not None:
                speech_to_first_text_s = (
                    time.perf_counter() - latency_speech_started_at
                )
                logging.info(
                    "[LATENCY] speech_to_first_text_sent=%.3fs chunk=%.3fs",
                    speech_to_first_text_s,
                    duration,
                )

                # Clear only the marker that produced this measurement. This
                # keeps the instrumentation safe even if another speech marker
                # were to appear before this send completes.
                if (
                    self._latency_pending_speech_started_at
                    == latency_speech_started_at
                ):
                    self._latency_pending_speech_started_at = None
