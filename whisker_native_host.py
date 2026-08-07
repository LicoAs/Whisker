import json
import os
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent
LAUNCHER = ROOT / "whisker_launcher.py"
STATE_FILE = ROOT / ".whisker_backend_state.json"

VALID_BACKENDS = {
    "cpu",
    "cuda",
    "vulkan",
    "rocm",
}


# Native Messaging en Windows necesita stdin/stdout en modo binario.
if os.name == "nt":
    import msvcrt

    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)


def log(message):
    # Nunca imprimir debugging a stdout: stdout pertenece al protocolo
    # Native Messaging.
    print(message, file=sys.stderr, flush=True)


def read_message():
    raw_length = sys.stdin.buffer.read(4)

    if len(raw_length) == 0:
        return None

    if len(raw_length) != 4:
        raise RuntimeError("Mensaje Native Messaging incompleto.")

    message_length = struct.unpack("=I", raw_length)[0]
    raw_message = sys.stdin.buffer.read(message_length)

    if len(raw_message) != message_length:
        raise RuntimeError("Payload Native Messaging incompleto.")

    return json.loads(raw_message.decode("utf-8"))


def send_message(message):
    encoded = json.dumps(message).encode("utf-8")

    sys.stdout.buffer.write(
        struct.pack("=I", len(encoded))
    )
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def is_port_open(host, port):
    try:
        with socket.create_connection((host, port), timeout=0.25):
            return True
    except OSError:
        return False


def wait_for_port(host, port, timeout=20.0):
    deadline = time.time() + timeout

    while time.time() < deadline:
        if is_port_open(host, port):
            return True

        time.sleep(0.2)

    return False


def wait_for_port_closed(host, port, timeout=5.0):
    deadline = time.time() + timeout

    while time.time() < deadline:
        if not is_port_open(host, port):
            return True

        time.sleep(0.2)

    return False


def load_state():
    if not STATE_FILE.exists():
        return None

    try:
        return json.loads(
            STATE_FILE.read_text(encoding="utf-8")
        )
    except Exception:
        return None


def save_state(backend, pid):
    STATE_FILE.write_text(
        json.dumps({
            "backend": backend,
            "pid": pid,
        }),
        encoding="utf-8",
    )


def clear_state():
    try:
        STATE_FILE.unlink()
    except FileNotFoundError:
        pass


def process_exists(pid):
    if os.name != "nt":
        return False

    result = subprocess.run(
        [
            "tasklist",
            "/FI",
            f"PID eq {pid}",
            "/FO",
            "CSV",
            "/NH",
        ],
        capture_output=True,
        text=True,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )

    return f'"{pid}"' in result.stdout


def stop_tracked_backend():
    state = load_state()

    if not state:
        return False

    pid = state.get("pid")

    if pid and process_exists(pid):
        subprocess.run(
            [
                "taskkill",
                "/PID",
                str(pid),
                "/T",
                "/F",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )

        wait_for_port_closed(
            "127.0.0.1",
            9090,
            timeout=5.0,
        )

    clear_state()
    return True


def start_backend(backend):
    if backend not in VALID_BACKENDS:
        raise ValueError(
            f"Backend inválido: {backend}"
        )

    if not LAUNCHER.exists():
        raise FileNotFoundError(
            f"No se encontró {LAUNCHER}"
        )

    state = load_state()

    if state:
        old_backend = state.get("backend")
        old_pid = state.get("pid")

        if (
            old_backend == backend
            and old_pid
            and process_exists(old_pid)
            and is_port_open("127.0.0.1", 9090)
        ):
            return {
                "ok": True,
                "status": "already_running",
                "backend": backend,
                "pid": old_pid,
            }

        stop_tracked_backend()

    elif is_port_open("127.0.0.1", 9090):
        raise RuntimeError(
            "El puerto 9090 ya está ocupado por un proceso "
            "que Whisker no inició."
        )

    process = subprocess.Popen(
        [
            sys.executable,
            str(LAUNCHER),
            backend,
        ],
        cwd=ROOT,
        creationflags=subprocess.CREATE_NEW_CONSOLE,
    )

    save_state(
        backend,
        process.pid,
    )

    if not wait_for_port(
        "127.0.0.1",
        9090,
        timeout=20.0,
    ):
        stop_tracked_backend()

        raise RuntimeError(
            f"El backend {backend} no abrió el puerto 9090."
        )

    return {
        "ok": True,
        "status": "ready",
        "backend": backend,
        "pid": process.pid,
    }


def handle_message(message):
    action = message.get("action")

    if action == "ping":
        return {
            "ok": True,
            "status": "pong",
        }

    if action == "start_backend":
        backend = message.get("backend")
        return start_backend(backend)

    if action == "stop_backend":
        stopped = stop_tracked_backend()

        return {
            "ok": True,
            "status": "stopped",
            "had_backend": stopped,
        }

    return {
        "ok": False,
        "error": f"Acción desconocida: {action}",
    }


def main():
    try:
        message = read_message()

        if message is None:
            return

        response = handle_message(message)

    except Exception as error:
        log(f"Native host error: {error}")

        response = {
            "ok": False,
            "error": str(error),
        }

    send_message(response)


if __name__ == "__main__":
    main()