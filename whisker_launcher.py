import os
import socket
import subprocess
import sys
import time
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "whisker_config.json"

with CONFIG_PATH.open("r", encoding="utf-8") as file:
    CONFIG = json.load(file)

VULKAN_ROOT = Path(r"C:\whisper-vulkan-test")
VULKAN_SERVER = VULKAN_ROOT / "whisper-server.exe"
VULKAN_MODEL = VULKAN_ROOT / "models" / "ggml-small.bin"

COMMON_ARGS = [
    "run_server.py",
    "--max_connection_time", "3600",
    "--omp_num_threads", "10",
]

BACKENDS = {
    "cpu": {
        "label": "Faster-Whisper — CPU",
        "command": [CONFIG["cpu_python"],
        *COMMON_ARGS,
        "--backend", "faster_whisper",],
    },
    "cuda": {
        "label": "Faster-Whisper — CUDA",
        "command": ["py", "-3.12", *COMMON_ARGS, "--backend", "faster_whisper"],
    },
    "vulkan": {
        "label": "whisper.cpp — Vulkan",
        "command": ["py", "-3.12", *COMMON_ARGS, "--backend", "whisper_cpp_vulkan"],
    },
    "rocm": {
        "label": "Faster-Whisper — ROCm",
        "command": [
            CONFIG["rocm_python"],
            *COMMON_ARGS,
            "--backend", "faster_whisper",
        ],
    },
}


def build_environment(backend):
    env = os.environ.copy()

    if backend == "rocm":
        rocm_path = r"C:\Program Files\AMD\ROCm\6.2"
        env["ROCM_PATH"] = rocm_path
        env["HIP_PATH"] = rocm_path
        env["PATH"] = str(Path(rocm_path) / "bin") + os.pathsep + env.get("PATH", "")

    return env


def is_port_open(host, port):
    try:
        with socket.create_connection((host, port), timeout=0.25):
            return True
    except OSError:
        return False


def wait_for_port(host, port, timeout=15.0):
    deadline = time.time() + timeout

    while time.time() < deadline:
        if is_port_open(host, port):
            return True
        time.sleep(0.2)

    return False


def start_vulkan_server():
    if is_port_open("127.0.0.1", 8080):
        print("whisper.cpp ya está escuchando en 127.0.0.1:8080")
        return None

    if not VULKAN_SERVER.exists():
        raise FileNotFoundError(f"No se encontró: {VULKAN_SERVER}")

    if not VULKAN_MODEL.exists():
        raise FileNotFoundError(f"No se encontró: {VULKAN_MODEL}")

    print("Iniciando whisper.cpp Vulkan en puerto 8080...")

    process = subprocess.Popen(
        [
            str(VULKAN_SERVER),
            "-m", str(VULKAN_MODEL),
            "--port", "8080",
            "-mc", "0",
            "-l", "auto",
        ],
        cwd=VULKAN_ROOT,
    )

    if not wait_for_port("127.0.0.1", 8080):
        if process.poll() is None:
            process.terminate()
        raise RuntimeError("whisper.cpp no abrió el puerto 8080.")

    print("whisper.cpp listo en 127.0.0.1:8080")
    return process


def main():
    if len(sys.argv) != 2 or sys.argv[1].lower() not in BACKENDS:
        print("Uso:")
        print("  py -3.12 whisker_launcher_v2.py cpu")
        print("  py -3.12 whisker_launcher_v2.py cuda")
        print("  py -3.12 whisker_launcher_v2.py vulkan")
        print("  py -3.12 whisker_launcher_v2.py rocm")
        sys.exit(1)

    backend = sys.argv[1].lower()
    config = BACKENDS[backend]

    print(f"Iniciando: {config['label']}")
    print(f"Directorio: {ROOT}")
    print()

    if backend == "vulkan":
        start_vulkan_server()
        print("Iniciando WhisperLive con backend Vulkan...")
        print()

    process = subprocess.Popen(
        config["command"],
        cwd=ROOT,
        env=build_environment(backend),
    )

    try:
        process.wait()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
