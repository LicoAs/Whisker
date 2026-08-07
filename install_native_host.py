import json
import winreg
from pathlib import Path


ROOT = Path(__file__).resolve().parent

HOST_NAME = "com.whisker.backend"
EXTENSION_ID = "hepiihodjhhcipepoandnpddpipflagf"

MANIFEST_PATH = ROOT / f"{HOST_NAME}.json"
HOST_BATCH = ROOT / "whisker_native_host.bat"


def main():
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


if __name__ == "__main__":
    main()