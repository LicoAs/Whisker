# Faster-Whisper with CTranslate2, ROCm 6.2 and RDNA2 on Windows

This guide documents a working setup for running Faster-Whisper on Windows using an AMD Radeon RX 6700 XT through CTranslate2 compiled against ROCm 6.2.

The setup was validated end-to-end with:

- Windows 11
- AMD Radeon RX 6700 XT
- GPU architecture: `gfx1031`
- ROCm 6.2
- CTranslate2 4.7.1
- Faster-Whisper
- Python 3.12
- `float16` inference
- Whisper `small`
- WhisperLive
- Live transcription through a Chrome extension
- Real GPU utilization confirmed during inference

> This setup was tested specifically on an RX 6700 XT. Other RDNA2 GPUs may work, but have not yet been validated.

---

## 1. Why a custom CTranslate2 build was required

Precompiled CTranslate2 ROCm wheels built against ROCm 7 could detect the GPU after manually changing the HIP runtime dependency, but failed during real inference because the ROCm 7 build was not ABI-compatible with ROCm 6.2.

A native build against ROCm 6.2 was therefore required.

The final working stack is:

```text
WhisperLive
    ↓
Faster-Whisper
    ↓
CTranslate2 4.7.1
    ↓
HIP / ROCm 6.2
    ↓
AMD Radeon RX 6700 XT / gfx1031
2. Requirements

Install the following components:

Windows 11
Python 3.12
Git
CMake
Ninja
Visual Studio 2022 Build Tools
MSVC C++ build tools
Windows SDK
Strawberry Perl
AMD ROCm 6.2 for Windows

ROCm must be installed at:

C:\Program Files\AMD\ROCm\6.2

The relevant runtime directory is:

C:\Program Files\AMD\ROCm\6.2\bin

Verify that the GPU is visible through ROCm before continuing.

The RX 6700 XT should be detected as:

gfx1031
3. Create a clean Python environment

Create a clean Python 3.12 virtual environment:

py -3.12 -m venv C:\Whisker\venv-rocm62

Activate it:

C:\Whisker\venv-rocm62\Scripts\activate

Upgrade pip:

python -m pip install --upgrade pip

Install Faster-Whisper:

python -m pip install faster-whisper

The environment used in the validated setup was:

C:\Whisker\venv-rocm62
4. Clone CTranslate2 4.7.1

Clone CTranslate2 with submodules:

git clone --recursive --branch v4.7.1 https://github.com/OpenNMT/CTranslate2.git C:\CTranslate2-rocm62

Enter the source directory:

cd /d C:\CTranslate2-rocm62
5. Configure the ROCm environment

Open:

x64 Native Tools Command Prompt for VS 2022

Set the ROCm variables:

set "ROCM_PATH=C:/Program Files/AMD/ROCm/6.2"
set "HIP_PATH=C:/Program Files/AMD/ROCm/6.2"
set "HIP_PLATFORM=amd"
set "PATH=C:\Program Files\AMD\ROCm\6.2\bin;%PATH%"

Forward slashes are recommended for CMake paths:

C:/Program Files/AMD/ROCm/6.2

This avoids escape-sequence issues with Windows backslashes.

6. Patch HIP warp synchronization

ROCm 6.2 does not expose __syncwarp in the same way as CUDA.

Open:

C:\CTranslate2-rocm62\src\cuda\helpers.h

Locate the relevant __syncwarp(mask) call and replace it with:

#ifdef CT2_USE_HIP
          // ROCm 6.2 does not expose __syncwarp; the following block-wide
          // synchronization makes this warp-only barrier unnecessary here.
#else
          __syncwarp(mask);
#endif
          smem[lane] = warpVal;

The following __syncthreads() call remains unchanged.

This patch only skips __syncwarp when compiling through HIP.

7. Configure CTranslate2

Configure the project with HIP enabled and target gfx1031.

OpenMP is disabled in the final working build because enabling it caused a runtime conflict with Intel OpenMP loaded by PyTorch or Silero VAD.

Run:

cmake -S . -B build -G Ninja ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DWITH_HIP=ON ^
  -DWITH_MKL=OFF ^
  -DWITH_OPENBLAS=OFF ^
  -DWITH_DNNL=OFF ^
  -DWITH_CUDA=OFF ^
  -DBUILD_TESTS=OFF ^
  -DBUILD_CLI=OFF ^
  -DOPENMP_RUNTIME=NONE ^
  -DCMAKE_HIP_ARCHITECTURES=gfx1031 ^
  -DCMAKE_HIP_COMPILER="C:/Program Files/AMD/ROCm/6.2/bin/clang++.exe" ^
  -DCMAKE_HIP_COMPILER_ROCM_ROOT="C:/Program Files/AMD/ROCm/6.2" ^
  -DCMAKE_CXX_FLAGS="-DHIPBLAS_V2" ^
  -DCMAKE_HIP_FLAGS="-DHIPBLAS_V2"
Important configuration details
Use Clang directly

Do not use:

hipcc.exe

as CMAKE_HIP_COMPILER.

Use:

C:\Program Files\AMD\ROCm\6.2\bin\clang++.exe

instead.

Enable hipBLAS v2

The following flags are required:

-DHIPBLAS_V2

Without them, compilation can fail because CTranslate2 uses hipDataType, while the legacy hipBLAS API expects hipblasDatatype_t.

Target the correct GPU

The RX 6700 XT uses:

gfx1031

The build commands for HIP files should contain:

--offload-arch=gfx1031
8. Build CTranslate2

Compile with Ninja:

cmake --build build -j 6

The resulting DLL should be created at:

C:\CTranslate2-rocm62\build\ctranslate2.dll
9. Install the custom DLL

The Python package is still used for the Python bindings, but its native DLL must be replaced with the custom ROCm 6.2 build.

Optional backup:

copy /Y ^
"C:\Whisker\venv-rocm62\Lib\site-packages\ctranslate2\ctranslate2.dll" ^
"C:\Whisker\venv-rocm62\Lib\site-packages\ctranslate2\ctranslate2.dll.prebuild.bak"

Copy the compiled DLL:

copy /Y ^
"C:\CTranslate2-rocm62\build\ctranslate2.dll" ^
"C:\Whisker\venv-rocm62\Lib\site-packages\ctranslate2\ctranslate2.dll"
10. Verify GPU detection

Run:

"C:\Whisker\venv-rocm62\Scripts\python.exe" -c "import os; h=os.add_dll_directory(r'C:\Program Files\AMD\ROCm\6.2\bin'); import ctranslate2; print('CTranslate2:', ctranslate2.__version__); print('ROCm devices:', ctranslate2.get_cuda_device_count())"

Expected output:

CTranslate2: 4.7.1
ROCm devices: 1

CTranslate2 uses the device name cuda internally for both CUDA and HIP backends.

Therefore, Faster-Whisper must still be created with:

device="cuda"

even though the physical GPU is AMD.

11. Test Faster-Whisper directly

Example test:

import os

ROCM_BIN = r"C:\Program Files\AMD\ROCm\6.2\bin"
ROCM_DLL_DIRECTORY = os.add_dll_directory(ROCM_BIN)

from faster_whisper import WhisperModel

model = WhisperModel(
    "small",
    device="cuda",
    compute_type="float16",
)

segments, info = model.transcribe(
    r"C:\path\to\audio.wav",
    beam_size=5,
)

print("Detected language:", info.language)

for segment in segments:
    print(f"[{segment.start:.2f} -> {segment.end:.2f}] {segment.text}")

The os.add_dll_directory handle must be stored in a variable so it remains active for the lifetime of the process.

12. WhisperLive integration

Install WhisperLive in editable mode from the repository root:

cd /d C:\Users\Lico\WhisperLive\WhisperLive
"C:\Whisker\venv-rocm62\Scripts\python.exe" -m pip install -e .

Install Silero VAD if required:

"C:\Whisker\venv-rocm62\Scripts\python.exe" -m pip install silero-vad
13. Load ROCm before importing Faster-Whisper

CTranslate2 may be imported by whisper_live.server before the backend module itself is loaded.

For that reason, ROCm must be added to the DLL search path at the beginning of:

run_server.py

Add this before importing WhisperLive, Faster-Whisper or CTranslate2:

import os

ROCM_BIN = os.environ.get(
    "ROCM_BIN",
    r"C:\Program Files\AMD\ROCm\6.2\bin",
)

_ROCM_DLL_DIRECTORY = None

if os.name == "nt" and os.path.isdir(ROCM_BIN):
    os.environ["PATH"] = ROCM_BIN + os.pathsep + os.environ.get("PATH", "")
    _ROCM_DLL_DIRECTORY = os.add_dll_directory(ROCM_BIN)

Saving the result of os.add_dll_directory prevents Python from closing the directory handle prematurely.

14. Detect the GPU through CTranslate2

PyTorch may report that no CUDA device is available even though CTranslate2 successfully detects the AMD GPU through HIP.

Do not use this logic:

device = "cuda" if torch.cuda.is_available() else "cpu"

Instead, use CTranslate2 directly:

import ctranslate2

if device is None:
    device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"

compute_type = "float16" if device == "cuda" else "int8"

The working backend logs:

Using CTranslate2 device=cuda with precision=float16 (ROCm devices detected=1)

The model is then initialized with:

WhisperModel(
    model_size_or_path,
    device=device,
    compute_type=compute_type,
)
15. OpenMP conflict

An initial build using OpenMP produced:

OMP: Error #15: Initializing libomp140.x86_64.dll,
but found libiomp5md.dll already initialized.

This happened because:

CTranslate2 loaded LLVM OpenMP
PyTorch, Silero or another dependency loaded Intel OpenMP

Do not use:

KMP_DUPLICATE_LIB_OK=TRUE

as a permanent solution.

It can hide the conflict and may cause crashes, degraded performance or incorrect results.

The final solution was to compile CTranslate2 with:

-DOPENMP_RUNTIME=NONE
16. Start WhisperLive

Use:

cd /d "C:\Users\Lico\WhisperLive\WhisperLive"

set "ROCM_PATH=C:\Program Files\AMD\ROCm\6.2"
set "HIP_PATH=C:\Program Files\AMD\ROCm\6.2"
set "ROCM_BIN=C:\Program Files\AMD\ROCm\6.2\bin"
set "PATH=%ROCM_BIN%;%PATH%"

"C:\Whisker\venv-rocm62\Scripts\python.exe" run_server.py ^
  --backend faster_whisper ^
  --max_connection_time 3600 ^
  --omp_num_threads 10

Expected startup output:

server listening on 0.0.0.0:9090

When the client connects:

connection open
New client connected
Using CTranslate2 device=cuda with precision=float16 (ROCm devices detected=1)
Loading model: small
17. Example BAT launcher

Create:

start_rocm_server.bat

with:

@echo off
title WhisperLive ROCm Server

cd /d "C:\Users\Lico\WhisperLive\WhisperLive"

set "ROCM_PATH=C:\Program Files\AMD\ROCm\6.2"
set "HIP_PATH=C:\Program Files\AMD\ROCm\6.2"
set "ROCM_BIN=C:\Program Files\AMD\ROCm\6.2\bin"
set "PATH=%ROCM_BIN%;%PATH%"

echo.
echo Starting WhisperLive with Faster-Whisper and ROCm 6.2...
echo.

"C:\Whisker\venv-rocm62\Scripts\python.exe" run_server.py ^
  --backend faster_whisper ^
  --max_connection_time 3600 ^
  --omp_num_threads 10

echo.
echo The server has stopped.
pause
18. Benchmark result

Validated using Whisper small on an audio file approximately 656.23 seconds long.

Model load
1.855 seconds
Run 1
Total time:       16.496 seconds
First segment:     1.703 seconds
Real-time factor:  0.0251
Speed:            39.78x real time
Segments:         39
Run 2
Total time:       16.314 seconds
First segment:     1.464 seconds
Real-time factor:  0.0249
Speed:            40.23x real time
Segments:         39
Run 3
Total time:       16.299 seconds
First segment:     1.449 seconds
Real-time factor:  0.0248
Speed:            40.26x real time
Segments:         39
Average
Total time:       16.369 seconds
Real-time factor:  0.0249
Speed:            40.09x real time
19. What was validated

The following behavior was confirmed:

ROCm 6.2 detects the RX 6700 XT
CTranslate2 detects one GPU
CTranslate2 loads successfully on Windows
Faster-Whisper loads with device="cuda"
float16 inference works
Whisper small works
Full audio-file transcription works
English and Spanish audio can be transcribed
WhisperLive starts normally
The Chrome extension connects through WebSocket
Live transcription works
Real GPU utilization was confirmed during inference
The system does not fall back to CPU
20. Known limitations
Only the RX 6700 XT / gfx1031 has been tested
Other RDNA2 GPUs are currently unverified
The build depends on ROCm 6.2
The generated DLL is not guaranteed to work with ROCm 7
The build currently uses no OpenMP inside CTranslate2
The __syncwarp change is a compatibility patch for HIP on ROCm 6.2
This setup should currently be considered experimental
21. Troubleshooting
CTranslate2 DLL cannot be loaded

Error:

Could not find module ctranslate2.dll or one of its dependencies

Verify that ROCm is added before importing CTranslate2:

ROCM_DLL_DIRECTORY = os.add_dll_directory(
    r"C:\Program Files\AMD\ROCm\6.2\bin"
)

Also verify:

set "PATH=C:\Program Files\AMD\ROCm\6.2\bin;%PATH%"
CTranslate2 detects zero devices

Verify the ROCm installation and architecture.

Run the ROCm device-information tool and confirm that the GPU appears as:

gfx1031

Also confirm that CTranslate2 was built with:

-DCMAKE_HIP_ARCHITECTURES=gfx1031
hipBLAS type errors during compilation

Ensure these flags are present:

-DCMAKE_CXX_FLAGS="-DHIPBLAS_V2"
-DCMAKE_HIP_FLAGS="-DHIPBLAS_V2"
__syncwarp is undefined

Apply the conditional HIP patch in:

src\cuda\helpers.h

Do not remove the later __syncthreads() call.

OpenMP Error #15

Rebuild CTranslate2 with:

-DOPENMP_RUNTIME=NONE

Do not rely permanently on:

KMP_DUPLICATE_LIB_OK=TRUE
WhisperLive uses CPU

Ensure the backend detects the device through:

ctranslate2.get_cuda_device_count()

and not through:

torch.cuda.is_available()

For the HIP build, CTranslate2 still expects:

device="cuda"
22. Final status

This configuration successfully runs Faster-Whisper with CTranslate2 4.7.1 and ROCm 6.2 on Windows using an AMD Radeon RX 6700 XT.

The setup was validated through both offline transcription and live WhisperLive transcription with confirmed GPU utilization.


Guardalo. Después, desde la consola, ejecutá:

```bat
git add docs\ROCM_WINDOWS_RDNA2.md
git commit -m "Add ROCm 6.2 RDNA2 build guide"
git push