"""Run explicitly in the build/operations container, never during document parsing."""
import json
import hashlib
import os
import sys
from pathlib import Path
from huggingface_hub import snapshot_download
from docling.utils.model_downloader import download_models

root = Path(os.environ.get("STUDIO_KNOWLEDGE_CACHE", "/models"))
revision = os.environ["STUDIO_EMBED_REVISION"]
expected_path = Path(__file__).with_name("models.lock.json")
if expected_path.is_file():
    expected = json.loads(expected_path.read_text())
    def cached_hash(relative):
        path = root / relative
        if not path.is_file():
            return None
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    if expected["embedding"] == revision and all(cached_hash(name) == digest for name, digest in expected["files"].items()):
        (root / "manifest.json").write_text(json.dumps(expected))
        print(f"Reused {len(expected['files'])} SHA-256-verified model files.", flush=True)
        sys.exit(0)
if len(revision) != 40:
    raise RuntimeError("Pin STUDIO_EMBED_REVISION to the reviewed 40-character model commit.")
print("Prefetching pinned Chinese/English OCR models...", flush=True)
download_models(output_dir=root / "docling", with_layout=False, with_tableformer=False, with_code_formula=False, with_picture_classifier=False, rapidocr_models=["onnxruntime:ch"], rapidocr_model_size="small", progress=True)
print("Prefetching pinned multilingual embeddings...", flush=True)
snapshot_download("intfloat/multilingual-e5-small", revision=revision, local_dir=root / "embedding", ignore_patterns=["onnx/*", "openvino/*", "*.h5", "*.bin"])
print("Prefetching Docling layout and table models...", flush=True)
download_models(output_dir=root / "docling", with_code_formula=False, with_picture_classifier=False, with_rapidocr=False, progress=True)
files = {}
for path in root.rglob("*"):
    if path.is_file() and ".cache" not in path.parts and path.name != "manifest.json":
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        files[str(path.relative_to(root))] = digest.hexdigest()
manifest = {"embedding": revision, "docling": "2.140.0", "ocr": "rapidocr:onnxruntime:ch:small", "files": files}
if expected_path.is_file() and json.loads(expected_path.read_text()) != manifest:
    raise RuntimeError("Model file hashes changed. Review the pinned model lock and rebuild its index before deployment.")
(root / "manifest.json").write_text(json.dumps(manifest))
print(f"Verified {len(files)} model files.", flush=True)
