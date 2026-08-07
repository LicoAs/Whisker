# Whisker

Whisker is a real-time speech transcription toolkit built for professional interpreters. It started as a fork of [WhisperLive](https://github.com/collabora/WhisperLive) and has since grown a dedicated **Interpreter Mode**, a privacy-first design, and an AMD ROCm backend for local GPU inference on Windows.

Currently shipped as a Chrome extension; a standalone Windows application is planned for the future.

## Why Whisker

Consecutive medical interpreting requires holding the general shape of long segments in your head while the speaker keeps talking. Whisker's Interpreter Mode is built specifically for that: live, low-latency transcription split by language or by speaking channel, so the interpreter can glance at the text instead of relying purely on memory.

- **Privacy by design**: interpreted content is never logged or stored. No session history, no server-side persistence.
- **Local-first**: transcription runs entirely on your own machine, no audio ever leaves it.
- **Built for accuracy over raw speed**: precision is treated as non-negotiable for medical interpreting, with GPU acceleration used to remove the speed/precision tradeoff rather than to shrink the model.

## Interpreter Mode

Two variants, accessible from the extension's task dropdown:

- **Manual** (primary mode): two columns split by speaking channel (Client / LEP), since the LEP side often mixes languages mid-sentence. Channel switching via keyboard arrows; a HOLD button/key pauses capture.
- **Auto** (experimental/secondary): two columns split by detected language, routed automatically per segment.

Audio is captured directly from the browser tab (or, optionally, full system audio) via an offscreen document — the interpreter views open in a separate window, not a tab.

## Backends

| Backend | Engine | Notes |
|---|---|---|
| CPU | faster-whisper | Reliable, near-perfect accuracy, slower |
| AMD ROCm (Windows) | faster-whisper + CTranslate2 | GPU-accelerated, validated on RX 6700 XT (RDNA2) — see [build guide](docs/ROCM_WINDOWS_RDNA2.md) |
| Vulkan | whisper.cpp | Faster raw throughput, currently on standby due to accuracy tradeoffs |
| CUDA | faster-whisper | Implemented, not yet validated on real hardware |

The ROCm path was built specifically to remove the "smaller model = faster" tradeoff: instead of shrinking the model to hit real-time speed, transcription is accelerated by GPU hardware while keeping the model size that gives acceptable precision for medical interpreting.

Full write-up of the ROCm 6.2 + CTranslate2 build on RDNA2/Windows: [`docs/ROCM_WINDOWS_RDNA2.md`](docs/ROCM_WINDOWS_RDNA2.md).

## Architecture notes

- **VAD gate**: audio is checked for real speech (Silero VAD) before it's ever sent to the transcription model, preventing hallucinations on pure silence.
- **Stability-based confirmation**: segments are confirmed when repeated output stabilizes, independent of silence detection, so brief pauses mid-sentence don't force premature confirmation.
- **Per-backend tuning**: polling interval and no-output overlap are tuned separately per backend, since backends differ in how they report empty/low-confidence results.

## Installation

- Install PortAudio (required system dependency for microphone input via PyAudio)

```bash
bash scripts/setup.sh
```

On Debian/Ubuntu this installs `portaudio19-dev`, on Fedora `portaudio-devel`, on macOS it uses Homebrew (`portaudio`).

- Python 3.12 is required.

```bash
python3.12 -m venv whisper_env
source whisper_env/bin/activate
pip install whisper-live
```

### AMD ROCm on Windows

Experimental support for Faster-Whisper with CTranslate2 and ROCm 6.2 on Windows, validated on an AMD Radeon RX 6700 XT (`gfx1031`):

- CTranslate2 4.7.1 compiled natively against ROCm 6.2
- `float16` inference
- Faster-Whisper integration
- WhisperLive live transcription
- Confirmed GPU utilization

Full guide: [`docs/ROCM_WINDOWS_RDNA2.md`](docs/ROCM_WINDOWS_RDNA2.md)

## Running the server

```bash
python3 run_server.py --port 9090 \
                      --backend faster_whisper \
                      --max_clients 4 \
                      --max_connection_time 600
```

Custom model / cache dir:

```bash
python3 run_server.py --port 9090 \
                      --backend faster_whisper \
                      -fw "/path/to/custom/faster/whisper/model" \
                      -c ~/.cache/whisper-live/
```

Control OpenMP threads with `--omp_num_threads`. Restrict clients with `--max_clients`. Limit connection time with `--max_connection_time`.

## Running the client

```bash
python3 run_client.py --files <audio-file-name>
```

```python
from whisper_live.client import TranscriptionClient
client = TranscriptionClient(
  "localhost",
  9090,
  lang="en",
  translate=False,
  model="small",
  use_vad=False,
)
client("tests/jfk.wav")   # transcribe a file
client()                  # transcribe from microphone
```

## Advanced features

- **Word-level timestamps**: `word_timestamps=True` on the client, returns per-word timing and confidence.
- **Custom vocabulary / hotwords**: `hotwords="term1,term2"` to boost recognition of domain-specific terms.
- **Speaker diarization**: `enable_diarization=True` (requires `pip install pyannote.audio`).
- **Batch inference**: `--batch_inference --batch_max_size 8 --batch_window_ms 50` on the server.
- **Raw PCM input**: `--raw_pcm_input` to accept int16/uint8/float32 audio directly.

## Docker

```bash
# CPU
docker run -it -p 9090:9090 ghcr.io/collabora/whisperlive-cpu:latest

# NVIDIA GPU (faster-whisper)
docker run -it --gpus all -p 9090:9090 ghcr.io/collabora/whisperlive-gpu:latest

# AMD ROCm
docker build -f docker/Dockerfile.rocm -t whisperlive-rocm .
docker run --rm -it --device=/dev/kfd --device=/dev/dri \
    --group-add "$(getent group video | cut -d: -f3)" \
    --group-add "$(getent group render | cut -d: -f3)" \
    -p 9090:9090 whisperlive-rocm
```

## Roadmap

- Native Messaging Host launcher (extension starts the server without a `.bat` file)
- Multi-backend selection from the UI (CPU / ROCm / Vulkan)
- Standalone Windows app (`.exe`), independent of Chrome
- Local, session-only glossary for medical terminology
- Manual text editing / word-level translation on selection

## Acknowledgements

Whisker is built on top of [WhisperLive](https://github.com/collabora/WhisperLive) by Collabora, which itself builds on [OpenAI Whisper](https://github.com/openai/whisper) and [Silero VAD](https://github.com/snakers4/silero-vad).

```bibtex
@article{Whisper,
  title = {Robust Speech Recognition via Large-Scale Weak Supervision},
  url = {https://arxiv.org/abs/2212.04356},
  author = {Radford, Alec and Kim, Jong Wook and Xu, Tao and Brockman, Greg and McLeavey, Christine and Sutskever, Ilya},
  publisher = {arXiv},
  year = {2022},
}
```

```bibtex
@misc{SileroVAD,
  author = {Silero Team},
  title = {Silero VAD: pre-trained enterprise-grade Voice Activity Detector (VAD), Number Detector and Language Classifier},
  year = {2021},
  publisher = {GitHub},
  journal = {GitHub repository},
  howpublished = {\url{https://github.com/snakers4/silero-vad}},
}
```
