"""Download ONNX data from official sherpa-onnx releases; execute no remote code."""
import hashlib
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
FILES = [
    ("speaker-segmentation-models", "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2", "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488"),
    ("speaker-recongition-models", "wespeaker_en_voxceleb_resnet34.onnx", "5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94"),
]


def install():
    target = ROOT / "models" / "diarization"
    target.mkdir(parents=True, exist_ok=True)
    for tag, name, digest in FILES:
        path = target / name
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            print(f"Downloading {name}", flush=True)
            partial = path.with_suffix(path.suffix + ".part")
            urllib.request.urlretrieve(f"https://github.com/k2-fsa/sherpa-onnx/releases/download/{tag}/{name}", partial)
            if hashlib.sha256(partial.read_bytes()).hexdigest() != digest:
                raise RuntimeError(f"Checksum mismatch: {name}")
            partial.replace(path)
        if name.endswith(".tar.bz2"):
            with tarfile.open(path) as archive:
                for source, dest in [("model.onnx", "segmentation.onnx"), ("LICENSE", "segmentation-LICENSE"), ("README.md", "segmentation-README.md")]:
                    member = archive.getmember(f"sherpa-onnx-pyannote-segmentation-3-0/{source}")
                    if not member.isfile():
                        raise RuntimeError("Expected a regular archive member")
                    (target / dest).write_bytes(archive.extractfile(member).read())
        print(f"Verified {name}", flush=True)


if __name__ == "__main__":
    install()
