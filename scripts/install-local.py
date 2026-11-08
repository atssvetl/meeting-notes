"""Install the pinned CPU runtime and exact user-requested model (no remote code)."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
import venv

ROOT = Path(__file__).resolve().parent.parent
REPO = "csukuangfj/sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16"
REVISION = "a6039be7cee829a9044a69ac0ebaf1c191217c97"
FILES = {
    "encoder.int8.onnx": (224570820, "369f35a71bf288d3b8e0391fabd8dba5f2314088d440bca474056b7b4b6e66bf"),
    "decoder.onnx": (4600132, "38fc7475443ea2a26f63211ca350f73ac50fff824ab7a3876ee2bd610c53bbc4"),
    "joiner.onnx": (2712896, "602ff7017a93311aad34df1437c8d7f49911353c13d6eae7a6ee7b041339465c"),
    "tokens.txt": (13354, "bd0cf91adfec3b5c83b7cf5769cf7b14059e4d51"),
    "LICENSE": (1070, "8d9a2e761e0feada9c9347a3f2265aee4653dba7"),
    "README.md": (302, "287b7907d7e2b6c9460d8bac56b336b0ce7f1881"),
    "test_wavs/example.wav": (361324, "d8aaaa18a5098d7c6de0595ae7ac1e64cacd0d4022af3595213bdaf23be77e69"),
}


def valid(path, size, digest):
    if not path.is_file() or path.stat().st_size != size:
        return False
    h = hashlib.sha256() if len(digest) == 64 else hashlib.sha1()
    if len(digest) == 40:
        h.update(f"blob {size}\0".encode())
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest() == digest


def main():
    env = ROOT / ".venv-local"
    python = env / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.exists():
        venv.EnvBuilder(with_pip=True).create(env)
    subprocess.run([str(python), "-m", "pip", "install", "--only-binary=:all:", "-r", str(ROOT / "requirements-local.txt")], check=True)
    target = ROOT / "models" / REPO.split("/")[1]
    for name, (size, digest) in FILES.items():
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if valid(path, size, digest):
            print(f"Проверен: {name}", flush=True)
            continue
        print(f"Загрузка: {name} ({size / 1e6:.1f} МБ)", flush=True)
        partial = path.with_suffix(path.suffix + ".part")
        with urllib.request.urlopen(f"https://huggingface.co/{REPO}/resolve/{REVISION}/{name}", timeout=120) as source, partial.open("wb") as dest:
            while chunk := source.read(1024 * 1024):
                dest.write(chunk)
        if not valid(partial, size, digest):
            raise RuntimeError(f"Не совпала контрольная сумма: {name}")
        partial.replace(path)
    (target / "installation.json").write_text(json.dumps({"repository": REPO, "revision": REVISION, "files": FILES}, indent=2), encoding="utf-8")
    subprocess.run([str(python), str(ROOT / "scripts" / "install-diarization.py")], check=True)
    subprocess.run([str(python), "-c", "import sherpa_onnx, numpy; print('sherpa-onnx:', sherpa_onnx.__version__)"], check=True)
    print("Локальная модель установлена. Перезапустите приложение.", flush=True)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
