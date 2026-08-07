import json
import shutil
import winreg
from pathlib import Path


ROOT = Path(__file__).resolve().parent

HOST_NAME = "com.whisker.backend"
EXTENSION_ID = "hepiihodjhhcipepoandnpddpipflagf"

MANIFEST_PATH = ROOT / f"{HOST_NAME}.json"
HOST_BATCH = ROOT / "whisker_native_host.bat"

CONFIG_PATH = ROOT / "whisker_config.json"
CONFIG_EXAMPLE_PATH = ROOT / "whisker_config.example.json"


def ensure_config():
    if CONFIG_PATH.exists():
        print(f"Configuración existente: {CONFIG_PATH}")
        return

    if not CONFIG_EXAMPLE_PATH.exists():
        raise FileNotFoundError(
            f"No se encontró: {CONFIG_EXAMPLE_PATH}"
        )

    shutil.copyfile(
        CONFIG_EXAMPLE_PATH,
        CONFIG_PATH,
    )

    print(f"Configuración creada: {CONFIG_PATH}")
    print("Revisá las rutas antes de iniciar un backend.")


def install_native_host():
    manifest = {
        "name": HOST_NAME,
        "description": "Whisker backend launcher",
        "path": str(HOST_BATCH),
        "type": "stdio",
        "allowed_origins": [
            f"chrome-extension://{EXTENSION_ID}/"
        ],
    }

    with MANIFEST_PATH.open(
        "w",
        encoding="utf-8",
    ) as file:
        json.dump(
            manifest,
            file,
            indent=4,
        )
        file.write("\n")

    registry_path = (
        rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"
    )

    with winreg.CreateKey(
        winreg.HKEY_CURRENT_USER,
        registry_path,
    ) as key:
        winreg.SetValueEx(
            key,
            "",
            0,
            winreg.REG_SZ,
            str(MANIFEST_PATH),
        )

    print("Native Messaging Host instalado.")
    print(f"Manifest: {MANIFEST_PATH}")
    print(f"Host:     {HOST_BATCH}")


def main():
    ensure_config()
    install_native_host()


if __name__ == "__main__":
    main()