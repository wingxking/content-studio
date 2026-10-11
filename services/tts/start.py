"""Seed immutable baked Kokoro weights into a dedicated non-synced cache."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

IMAGE = "ghcr.io/remsky/kokoro-fastapi-cpu:v0.9.0@sha256:ee3111d6a2c903ed62f3b4fa19543c6901205ed39fce3c177e895b34a8386b9c"
cache = Path(os.environ.get("STUDIO_TTS_CACHE_DIR", "/tts-cache")).resolve()
cache.mkdir(parents=True, exist_ok=True)


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def seed(source: Path, target: Path) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for file in sorted(source.rglob("*")):
        if not file.is_file() or file.is_symlink():
            continue
        relative = file.relative_to(source)
        expected = digest(file)
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.is_file() or destination.is_symlink() or digest(destination) != expected:
            descriptor, temporary = tempfile.mkstemp(dir=destination.parent, prefix=".seed-")
            os.close(descriptor)
            try:
                shutil.copyfile(file, temporary)
                with open(temporary, "rb") as handle:
                    os.fsync(handle.fileno())
                os.replace(temporary, destination)
            finally:
                Path(temporary).unlink(missing_ok=True)
        hashes[str(relative)] = expected
    return hashes


models = seed(Path("/app/api/src/models"), cache / "models")
voices = seed(Path("/app/api/src/voices/v1_0"), cache / "voices")
if not any(name.endswith((".pth", ".pt", ".safetensors")) for name in models) or not voices:
    raise RuntimeError("Pinned CPU image does not contain usable baked model and voice files")
manifest = {"image": IMAGE, "models": models, "voices": voices}
fingerprint = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
manifest["fingerprint"] = fingerprint
(cache / "fingerprint.json").write_text(json.dumps(manifest, indent=2))
print(f"Kokoro CPU model/voice fingerprint: {fingerprint}", flush=True)
environment = {**os.environ, "MODEL_DIR": str(cache / "models"), "VOICES_DIR": str(cache / "voices"),
               "DOWNLOAD_MODEL": "false", "API_LOG_LEVEL": "WARNING", "USE_GPU": "false", "DEVICE": "cpu", "HF_HOME": str(cache / "huggingface"),
               "XDG_CACHE_HOME": str(cache / "runtime"), "ENABLE_DEBUG_ENDPOINTS": "false", "ALLOW_DEV_UNLOAD": "false",
               "ENABLE_VOICE_TAGS": "false", "ENABLE_SSML": "false"}
os.execvpe(sys.executable, [sys.executable, "-m", "uvicorn", "api.src.main:app", "--host", os.environ.get("HOST", "0.0.0.0"),
                          "--port", os.environ.get("PORT", "8880"), "--log-level", "warning"], environment)
