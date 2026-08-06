"""
Prueba aislada de ServeClientWhisperCppVulkan, sin WebSocket ni extensión.

Cómo correrlo (ver instrucciones completas en el chat):
    python test_backend_whispercpp.py

Requiere:
    - whisper-server.exe corriendo (con -mc 0 -l auto, como ya validamos).
    - Este script parado en una carpeta desde donde se pueda "import whisper_live"
      (normalmente la raíz de tu repo, C:\\Users\\Lico\\WhisperLive\\WhisperLive).
"""

import wave
import numpy as np

from whisper_live.backend.whispercpp_vulkan_backend import ServeClientWhisperCppVulkan


# --- 1. Un "websocket" falso: solo necesitamos que tenga .send() ---
class FakeWebSocket:
    def send(self, message):
        print(f"[WS -> cliente] {message}")


# --- 2. Cargar un chunk.wav como array float32, igual que lo hace base.py ---
def load_wav_as_float32(path):
    with wave.open(path, "rb") as wf:
        rate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)
    int16_samples = np.frombuffer(raw, dtype=np.int16)
    float32_samples = int16_samples.astype(np.float32) / 32768.0
    return float32_samples, rate


if __name__ == "__main__":
    chunk_path = r"C:\whisper-vulkan-test\chunk.wav"  # <-- ajustá esta ruta si hace falta

    audio, rate = load_wav_as_float32(chunk_path)
    print(f"Audio cargado: {len(audio) / rate:.2f}s @ {rate}Hz\n")

    backend = ServeClientWhisperCppVulkan(
        websocket=FakeWebSocket(),
        client_uid="test-uid",
        server_url="http://127.0.0.1:8080/inference",
        language=None,  # None = auto-detect (es/en), como en la extensión
    )

    print("Llamando a transcribe_audio()...\n")
    segments = backend.transcribe_audio(audio)

    print(f"Segmentos devueltos: {len(segments)}\n")
    for i, seg in enumerate(segments):
        print(f"--- Segmento {i} ---")
        print(f"  texto: {seg.text!r}")
        print(f"  start: {seg.start}  end: {seg.end}")
        print(f"  no_speech_prob: {seg.no_speech_prob}")
        if seg.words:
            print(f"  palabras: {len(seg.words)} (ej: {seg.words[0].word!r} p={seg.words[0].probability:.2f})")
        else:
            print("  palabras: (sin word_timestamps)")

    backend.cleanup()  # frena el thread interno de speech_to_text antes de salir