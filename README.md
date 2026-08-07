# Whisker

Whisker is a local, real-time speech transcription toolkit built specifically for professional interpreters.

It started as a fork of [WhisperLive](https://github.com/collabora/WhisperLive) and has since evolved around a dedicated interpreter workflow, local-first privacy, automatic backend management, and GPU-accelerated inference on AMD hardware under Windows.

Whisker currently runs as a Chrome extension backed by a local transcription server. The extension can launch and manage the server automatically through a Native Messaging Host, with no manual `.bat` launcher required.

A standalone Windows application is planned for the future.

## Why Whisker

Consecutive interpreting often requires retaining names, symptoms, medical terminology, instructions, and the overall structure of long spoken segments while the speaker is still talking.

Whisker is designed as a temporary visual memory aid: it produces low-latency transcription that the interpreter can glance at while listening instead of relying entirely on handwritten notes or memory.

The project follows three main principles:

* **Privacy first** — transcription is processed locally. Audio does not need to be sent to a remote transcription service.
* **Ephemeral by design** — interpreted content is not intended to become a persistent conversation archive or session history.
* **Accuracy before model size** — reducing latency should not require dropping to a substantially less accurate model. GPU acceleration is used to preserve transcription quality while keeping inference fast enough for real-time use.

## Interpreter Mode

Interpreter Mode is the primary Whisker workflow and can be selected directly from the extension UI.

Two variants are available.

### Manual mode

The primary mode for professional interpreting.

The transcription window is split into two speaking channels:

* **Client**
* **LEP**

The interpreter explicitly chooses which side is currently speaking instead of relying on automatic language detection to determine where text belongs.

This is intentional. Real interpreting sessions frequently contain:

* code-switching
* English medical terminology inside Spanish speech
* names and acronyms from another language
* speakers temporarily switching languages
* mixed-language sentences

Channel switching can be controlled from the keyboard, and audio capture can be temporarily paused using the **HOLD** control.

### Auto mode

An experimental secondary mode.

Instead of manually selecting the speaking channel, transcription is routed according to the detected language of each segment.

This can work well for simpler bilingual conversations, but Manual mode remains the preferred workflow when speaker identity matters more than detected language.

## Chrome extension

The Chrome extension provides the main Whisker interface.

Audio can be captured directly from the browser tab, with optional system-audio capture depending on the configured input path.

The transcription interface opens in a separate window so it can remain visible while the interpreter works in another browser tab or application.

The extension also handles:

* task / mode selection
* transcription backend selection
* launching the local backend
* switching between Interpreter Mode variants
* opening the transcription interface
* communicating with the local server

## Native Messaging Host

Whisker includes a Chrome Native Messaging Host that bridges the extension and the local transcription environment.

The extension can start and manage the required local server automatically, removing the need for the user to manually launch a `.bat` file before starting transcription.

This allows the browser extension to behave much more like a standalone application while keeping inference local.

## Backend selection

The active transcription backend can be selected directly from the extension UI.

This makes it possible to switch inference engines without manually changing server commands or configuration files.

Current backend paths include:

| Backend             | Engine                       | Status                                                  |
| ------------------- | ---------------------------- | ------------------------------------------------------- |
| CPU                 | Faster-Whisper / CTranslate2 | Supported                                               |
| AMD ROCm on Windows | Faster-Whisper / CTranslate2 | **Validated on RX 6700 XT / RDNA2**                     |
| Vulkan              | whisper.cpp                  | Experimental / standby                                  |
| NVIDIA CUDA         | Faster-Whisper / CTranslate2 | Implemented, not yet validated on local NVIDIA hardware |

## AMD ROCm on Windows

Whisker includes a native Faster-Whisper GPU path for AMD hardware on Windows.

The current reference configuration is:

* Windows 11
* AMD Radeon RX 6700 XT
* RDNA2 / `gfx1031`
* ROCm 6.2
* CTranslate2 4.7.1 compiled natively with HIP
* Faster-Whisper
* Whisper `small`
* `float16` inference
* live GPU-backed transcription

CTranslate2 exposes the HIP/ROCm backend through its CUDA-compatible device interface, allowing Faster-Whisper to use the AMD GPU without requiring changes to Faster-Whisper's public API.

The goal of the ROCm backend is not simply maximum benchmark throughput.

For Whisker, GPU acceleration exists primarily to remove the usual tradeoff between transcription speed and model accuracy: instead of shrinking the Whisper model to meet real-time latency requirements, the same higher-accuracy model can be accelerated in hardware.

Full Windows/RDNA2 build notes:

`docs/ROCM_WINDOWS_RDNA2.md`

## ROCm performance

Using Whisper `small` on the reference RX 6700 XT configuration, a **656.23-second** reference recording produced the following results:

| Metric                     |               Result |
| -------------------------- | -------------------: |
| Average transcription time |          **16.37 s** |
| Real-time factor           |           **0.0249** |
| Throughput                 | **40.09× real time** |
| Model load time            |          **~1.86 s** |
| First segment              |     **~1.45–1.70 s** |

Three consecutive benchmark runs completed in approximately:

* 16.496 s
* 16.314 s
* 16.299 s

Raw offline throughput is not equivalent to live transcription latency, since the live path also depends on audio buffering, partial results, polling, and segment confirmation behavior.

The benchmark is primarily useful for confirming that inference itself is comfortably faster than real time.

## Vulkan backend

Whisker also includes an experimental `whisper.cpp` Vulkan backend.

On the same reference audio, Vulkan has demonstrated substantially higher raw throughput than the Faster-Whisper ROCm path, reaching roughly **68–80× real time** during testing.

However, Whisker is not optimized around benchmark speed alone.

The Vulkan backend is currently kept on standby because the Faster-Whisper path has produced more reliable transcription behavior on the reference bilingual medical audio used during development.

For professional interpreting, transcription quality and stability take priority once inference is already comfortably faster than real time.

## Streaming transcription

Whisker's streaming behavior is designed around live interpreting rather than offline transcription.

### Partial transcription

Text can appear while the current speech segment is still evolving, giving the interpreter useful information without waiting for the entire utterance to finish.

### Stability-based confirmation

Partial output is not immediately treated as final.

Segments are confirmed when repeated transcription becomes sufficiently stable across updates.

This is intentionally separate from silence detection: a brief pause in the middle of a sentence should not automatically finalize incomplete text.

### Backend-specific tuning

Different inference engines behave differently when given:

* short audio buffers
* growing audio buffers
* silence
* low-confidence speech
* incomplete sentences
* overlapping windows

Whisker therefore allows streaming parameters to be tuned per backend instead of assuming a single configuration will behave identically under Faster-Whisper, ROCm, CUDA, and `whisper.cpp`.

## Silence and hallucination handling

Silence handling is currently an active area of refinement.

The next filtering layer being evaluated is an external **Silero VAD gate** placed before Faster-Whisper.

The intended design is simple:

1. inspect the incoming audio for real speech
2. require a minimum amount of detected speech
3. skip Whisper entirely when the buffer contains insufficient speech
4. keep transcript stability and confirmation logic independent from VAD

The goal is to prevent hallucinations caused by long or nearly silent buffers without adding multiple overlapping heuristics to the transcription path.

## Accuracy

Whisker is primarily tested against real bilingual interpreting audio rather than generic speech-recognition benchmarks.

Current testing focuses especially on:

* English ↔ Spanish conversations
* medical terminology
* code-switching
* incomplete sentences
* pauses inside longer utterances
* mixed-language speech
* silence-induced hallucinations
* partial transcript stability
* speaker/channel separation

The current Faster-Whisper `small` configuration has produced very high accuracy on the reference bilingual medical audio used during development.

Critical information such as:

* phone numbers
* identification numbers
* confirmation codes
* account numbers
* exact numeric values

should still be verified manually rather than trusted blindly from automatic speech recognition.

Whisker is intended to assist interpreter memory, not replace interpreter judgment.

## Architecture

At a high level:

```text
Browser / audio source
        │
        ▼
Chrome extension
        │
        ├── Interpreter Mode UI
        ├── Backend selection
        ├── Audio capture
        │
        ▼
Native Messaging Host
        │
        ▼
Local transcription server
        │
        ├── Faster-Whisper / CPU
        ├── Faster-Whisper / AMD ROCm
        ├── Faster-Whisper / CUDA
        └── whisper.cpp / Vulkan
        │
        ▼
Streaming transcription
        │
        ├── Partial output
        ├── Stability tracking
        └── Confirmed segments
        │
        ▼
Interpreter window
```

All transcription processing remains local to the machine.

## Installation

### Requirements

* Python 3.12
* Chrome or a Chromium-based browser
* PortAudio / PyAudio where microphone capture is required
* backend-specific GPU dependencies when using hardware acceleration

Create a Python environment:

```bash
python3.12 -m venv whisper_env
```

Linux/macOS:

```bash
source whisper_env/bin/activate
```

Windows PowerShell:

```powershell
.\whisper_env\Scripts\Activate.ps1
```

Install the upstream WhisperLive Python package:

```bash
pip install whisper-live
```

Whisker's development environment may contain additional backend-specific dependencies.

### PortAudio

Debian / Ubuntu:

```bash
sudo apt install portaudio19-dev
```

Fedora:

```bash
sudo dnf install portaudio-devel
```

macOS:

```bash
brew install portaudio
```

Windows installations generally use the appropriate PyAudio wheel / environment for the selected Python version.

### AMD ROCm on Windows

The Windows ROCm path requires a custom CTranslate2 build compiled against ROCm/HIP.

The validated Whisker configuration uses:

* ROCm 6.2
* CTranslate2 4.7.1
* `gfx1031`
* Python 3.12
* Faster-Whisper
* `float16`

See:

`docs/ROCM_WINDOWS_RDNA2.md`

for the full build and setup process.

## Running the server manually

The extension normally manages the server through the Native Messaging Host.

For development and debugging, it can still be started manually:

```bash
python3 run_server.py \
    --port 9090 \
    --backend faster_whisper \
    --max_clients 4 \
    --max_connection_time 600
```

A custom Faster-Whisper model or cache directory can also be supplied:

```bash
python3 run_server.py \
    --port 9090 \
    --backend faster_whisper \
    -fw "/path/to/custom/faster/whisper/model" \
    -c ~/.cache/whisper-live/
```

Additional options include:

* `--omp_num_threads` — control OpenMP thread count
* `--max_clients` — restrict simultaneous clients
* `--max_connection_time` — limit individual connection duration

## Python client

The upstream-compatible Python client remains useful for backend testing.

Transcribe an audio file:

```bash
python3 run_client.py --files <audio-file-name>
```

Or use the client directly:

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

client("tests/jfk.wav")
client()
```

The Chrome extension and Interpreter Mode are the primary Whisker user interface.

## Upstream WhisperLive capabilities

Because Whisker retains WhisperLive as part of its foundation, several upstream features remain available depending on backend and configuration.

These include:

* word-level timestamps
* hotwords / custom vocabulary
* speaker diarization
* batch inference
* raw PCM input
* CPU inference
* CUDA inference

These capabilities should be considered part of the underlying transcription platform and are not necessarily part of Whisker's primary Interpreter Mode workflow.

## Docker

Upstream-compatible CPU and NVIDIA containers can still be useful for server development.

### CPU

```bash
docker run -it -p 9090:9090 \
    ghcr.io/collabora/whisperlive-cpu:latest
```

### NVIDIA GPU

```bash
docker run -it --gpus all -p 9090:9090 \
    ghcr.io/collabora/whisperlive-gpu:latest
```

### Linux ROCm

Where supported:

```bash
docker build \
    -f docker/Dockerfile.rocm \
    -t whisperlive-rocm .
```

```bash
docker run --rm -it \
    --device=/dev/kfd \
    --device=/dev/dri \
    --group-add "$(getent group video | cut -d: -f3)" \
    --group-add "$(getent group render | cut -d: -f3)" \
    -p 9090:9090 \
    whisperlive-rocm
```

The native Windows ROCm path used by Whisker is separate from this Linux Docker environment.

## Development philosophy

For the transcription path, Whisker intentionally favors small, measurable changes over large stacks of heuristics.

The current development process follows a simple rule:

> one change → one complete test → compare against the reference → keep or revert

This is particularly important for speech recognition, where a change that fixes one edge case can easily degrade another.

Accuracy regressions are treated as more important than small performance gains once the system is already comfortably faster than real time.

## Roadmap

Current planned work includes:

* external Silero VAD gating before Faster-Whisper
* continued ROCm vs. Vulkan accuracy and latency testing
* further refinement of streaming / silence behavior
* standalone Windows application independent of Chrome
* local session-only glossary support for terminology
* controlled transcript editing and word-level tools

## Project status

Whisker is under active development.

The current primary reference configuration is:

**Windows 11 + AMD RX 6700 XT + ROCm 6.2 + CTranslate2 4.7.1 + Faster-Whisper `small`**

The main Chrome extension workflow, Interpreter Mode, Native Messaging Host, automatic server launching, and backend selection are already implemented.

The current development focus is improving silence handling without sacrificing the transcription accuracy and stability already achieved by the Faster-Whisper ROCm path.

## Acknowledgements

Whisker is built on top of [WhisperLive](https://github.com/collabora/WhisperLive) by Collabora.

WhisperLive itself builds upon or integrates projects including:

* [OpenAI Whisper](https://github.com/openai/whisper)
* [Faster-Whisper](https://github.com/SYSTRAN/faster-whisper)
* [CTranslate2](https://github.com/OpenNMT/CTranslate2)
* [Silero VAD](https://github.com/snakers4/silero-vad)

Whisker additionally uses and experiments with:

* [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
* AMD ROCm / HIP for local GPU inference on Windows

### Whisper

```bibtex
@article{Whisper,
    title = {Robust Speech Recognition via Large-Scale Weak Supervision},
    url = {https://arxiv.org/abs/2212.04356},
    author = {Radford, Alec and Kim, Jong Wook and Xu, Tao and Brockman, Greg and McLeavey, Christine and Sutskever, Ilya},
    publisher = {arXiv},
    year = {2022},
}
```

### Silero VAD

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
