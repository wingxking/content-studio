"""Copy only reviewed model files out of the disposable download cache."""
import hashlib
import json
import shutil
import sys
from pathlib import Path


def export_models(source: Path, destination: Path):
    source = source.resolve()
    manifest = json.loads((source / "manifest.json").read_text())
    destination.mkdir(parents=True, exist_ok=True)
    destination.chmod(0o755)
    for relative, expected in manifest["files"].items():
        path = (source / relative).resolve()
        if Path(relative).is_absolute() or not path.is_relative_to(source) or not path.is_file():
            raise ValueError("Model manifest contains an invalid file.")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        with path.open("rb") as incoming, target.open("wb") as outgoing:
            for block in iter(lambda: incoming.read(1024 * 1024), b""):
                digest.update(block)
                outgoing.write(block)
        if digest.hexdigest() != expected:
            target.unlink()
            raise ValueError("Model changed while exporting the verified cache.")
        target.chmod(0o644)
    shutil.copyfile(source / "manifest.json", destination / "manifest.json")
    (destination / "manifest.json").chmod(0o644)
    print(f"Exported {len(manifest['files'])} verified files; download caches excluded.", flush=True)


if __name__ == "__main__":
    export_models(Path(sys.argv[1]), Path(sys.argv[2]))
