"""Private CPU-only evidence tools. No database, URL fetching, scheduler or credentials."""
import base64
import hashlib
import json
import os
import tempfile
import threading
import math
import time
from pathlib import Path
from functools import lru_cache

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI()
lock = threading.Lock()
EMBED_MODEL = "intfloat/multilingual-e5-small"
MODEL_REVISION = os.environ.get("STUDIO_EMBED_REVISION", "")
CACHE = Path(os.environ.get("STUDIO_KNOWLEDGE_CACHE", "/models"))


class EmbeddingRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=64)
    query: bool = False


class PdfRequest(BaseModel):
    content: str = Field(min_length=1, max_length=70 * 1024 * 1024)


@app.get("/healthz")
def health():
    return {"healthy": True}


@app.get("/readyz")
def ready():
    if not verified_models():
        raise HTTPException(503, "Preload pinned knowledge models before enabling evidence production.")
    return {"ready": True, "embedding": EMBED_MODEL, "revision": MODEL_REVISION}


@lru_cache(maxsize=1)
def verified_models():
    try:
        manifest = json.loads((CACHE / "manifest.json").read_text())
        if manifest["embedding"] != MODEL_REVISION or manifest["docling"] != "2.140.0" or not manifest["files"]:
            return False
        for relative, expected in manifest["files"].items():
            path = (CACHE / relative).resolve()
            if not path.is_relative_to(CACHE.resolve()) or not path.is_file():
                return False
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != expected:
                return False
        return True
    except (KeyError, ValueError, OSError):
        return False


@app.post("/embed")
def embed(request: EmbeddingRequest):
    ready()
    if sum(len(text) for text in request.texts) > 100000 or any(len(text) > 12000 for text in request.texts):
        raise HTTPException(413, "Embedding input exceeds the batch limit.")
    with lock:
        from sentence_transformers import SentenceTransformer
        model = SentenceTransformer(str(CACHE / "embedding"), device="cpu", local_files_only=True, trust_remote_code=False)
        texts = [("query: " if request.query else "passage: ") + text for text in request.texts]
        vectors = model.encode(texts, normalize_embeddings=True, batch_size=8).tolist()
        del model
        return {"vectors": vectors, "version": f"{EMBED_MODEL}@{MODEL_REVISION}"}


@app.post("/pdf")
def pdf(request: PdfRequest):
    ready()
    try:
        content = base64.b64decode(request.content, validate=True)
    except ValueError:
        raise HTTPException(400, "Invalid PDF encoding.")
    if len(content) > 50 * 1024 * 1024 or not content.startswith(b"%PDF-"):
        raise HTTPException(400, "Upload a PDF of at most 50 MiB.")
    with lock, tempfile.TemporaryDirectory(prefix="studio-pdf-") as temporary:
        from docling.document_converter import DocumentConverter, PdfFormatOption
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions
        from docling.datamodel.accelerator_options import AcceleratorOptions, AcceleratorDevice
        import pypdfium2

        path = Path(temporary) / "source.pdf"
        path.write_bytes(content)
        options = PdfPipelineOptions(artifacts_path=CACHE / "docling")
        options.accelerator_options = AcceleratorOptions(num_threads=2, device=AcceleratorDevice.CPU)
        options.do_ocr = True
        options.ocr_options = RapidOcrOptions(backend="onnxruntime", lang=["ch"], model_size="small")
        options.document_timeout = 60
        options.enable_remote_services = False
        converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
        text_parts, pages, offset = [], [], 0
        deadline = time.monotonic() + 480
        # The pinned parser can merge rotated scan pages. Convert each physical
        # page independently, then retain the original PDF page number.
        with pypdfium2.PdfDocument(path) as source:
            if not 1 <= len(source) <= 200:
                raise HTTPException(422, "PDF must contain at most 200 physical pages.")
            for index in range(len(source)):
                if time.monotonic() >= deadline:
                    raise HTTPException(422, "PDF conversion exceeded its document budget.")
                single_path = Path(temporary) / f"page-{index + 1}.pdf"
                physical_page = source[index]
                try:
                    original_text = physical_page.get_textpage()
                    try:
                        scanned = not original_text.get_text_range().strip()
                    finally:
                        original_text.close()
                finally:
                    physical_page.close()
                with pypdfium2.PdfDocument.new() as single:
                    single.import_pages(source, [index])
                    single.save(single_path)
                result = converter.convert(single_path, max_num_pages=1)
                if str(result.status.value) != "success" or len(result.document.pages) != 1:
                    raise HTTPException(422, "PDF conversion incomplete; source withheld.")
                confidence = result.confidence
                grades = [confidence.low_grade, *(page.low_grade for page in confidence.pages.values())]
                if any(str(getattr(grade, "value", grade)).lower() == "poor" for grade in grades):
                    raise HTTPException(422, "PDF extraction confidence is low; source withheld.")
                if any(not table.data.table_cells for table in result.document.tables):
                    raise HTTPException(422, "PDF contains an incompletely extracted table.")
                value = result.document.export_to_markdown()
                single_path.unlink()
                if not value.strip():
                    continue
                heading = "表格数字待核对" if result.document.tables else ""
                if scanned or not math.isfinite(confidence.ocr_score) or confidence.ocr_score < 0.8:
                    heading += " OCR数字待核对"
                text_parts.append(value)
                units = len(value.encode("utf-16-le")) // 2
                pages.append({"page": index + 1, "start": offset, "end": offset + units, "heading": heading.strip()})
                offset += units + 2
        text = "\n\n".join(text_parts)
        if len(text) < 80 or len(text) > 8 * 1024 * 1024:
            raise HTTPException(422, "PDF has insufficient or excessive text.")
        return {"title": "PDF", "text": text, "pages": pages, "sha256": hashlib.sha256(content).hexdigest(), "parserVersion": "docling-2.140.0-physical-v3"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8920, access_log=False)
