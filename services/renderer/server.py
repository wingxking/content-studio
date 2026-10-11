"""Internal, prepared-media-only adapter for the pinned MPT video-project CLI."""
from __future__ import annotations

import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA_ROOT = Path(os.environ.get("STUDIO_DATA_DIR", "/data")).resolve()
PROJECT_ROOT = DATA_ROOT / "renderers" / "mpt" / "projects"
TOKEN = os.environ.get("STUDIO_RENDERER_TOKEN", "")
UPSTREAM_MODULE = "app.services.video_project"
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
HASH = re.compile(r"^[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{32}$")


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".studio-write-")
    try:
        with os.fdopen(descriptor, "w") as target:
            json.dump(value, target, allow_nan=False)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def local_path(raw: object) -> Path:
    if not isinstance(raw, str):
        raise ValueError("A local prepared manifest path is required")
    path = Path(raw).resolve(strict=True)
    if not path.is_relative_to(DATA_ROOT) or not path.is_file():
        raise ValueError("Prepared files must be regular files inside the shared data root")
    return path


def cli(project: Path, command: str, arguments: list[str]) -> object:
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(
            [sys.executable, "-m", UPSTREAM_MODULE, "--project", str(project), command, *arguments],
            stdout=out, stderr=errors, start_new_session=True,
        )
        try:
            process.wait(timeout=1800 if command == "render" else 300)
        except subprocess.TimeoutExpired:
            import signal
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise ValueError("Renderer deadline exceeded; retry preserves completed artifacts") from None
        if process.returncode:
            errors.seek(0, os.SEEK_END)
            errors.seek(max(0, errors.tell() - 8192))
            diagnostic = errors.read().decode(errors="replace").replace(str(DATA_ROOT), "<data>")
            sys.stderr.write(f"MPT {command} diagnostic: {diagnostic}\n")
            # Do not expose raw paths or arbitrary upstream diagnostics through HTTP.
            raise ValueError(f"MPT {command} failed; inspect the private renderer service diagnostics")
        if out.tell() > 2 * 1024 * 1024:
            raise ValueError("Renderer receipt exceeded its limit")
        out.seek(0)
        return json.load(out)


def toolchain_versions() -> dict:
    return {tool: subprocess.run([tool, "-version"], capture_output=True, text=True, check=True, timeout=10).stdout.splitlines()[0]
            for tool in ("ffmpeg", "ffprobe")}


def manifest_contract(manifest: dict, base: Path) -> dict:
    if set(manifest) - {"project_id", "settings", "scenes", "bgm"}:
        raise ValueError("Unknown prepared project fields")
    scenes = []
    for scene in manifest.get("scenes", []):
        if not isinstance(scene, dict) or set(scene) - {"id", "footage", "audio", "narration", "duration"}:
            raise ValueError("Unknown scene fields")
        footage = local_path(str((base / scene["footage"]).resolve()))
        audio = local_path(str((base / scene["audio"]).resolve())) if scene.get("audio") else None
        scenes.append({"id": scene["id"], "footage": digest(footage), "audio": digest(audio) if audio else None,
                       "narration": scene.get("narration", ""), "duration": scene.get("duration", 5.0)})
    settings = {"width": 1080, "height": 1920, "fps": 30, "narration_volume": 1.0, "bgm_volume": 0.15,
                **manifest.get("settings", {})}
    bgm = local_path(str((base / manifest["bgm"]).resolve())) if manifest.get("bgm") else None
    return {"project_id": manifest["project_id"], "settings": settings, "scenes": scenes,
            "bgm": digest(bgm) if bgm else None, "toolchain": toolchain_versions()}


def spec_contract(spec: dict) -> dict:
    return {"project_id": spec["project_id"], "settings": spec["settings"], "toolchain": spec["toolchain"], "bgm": spec["bgm"]["sha256"] if spec.get("bgm") else None,
            "scenes": [{"id": scene["id"], "footage": scene["footage"]["sha256"],
                        "audio": scene["audio"]["sha256"] if scene.get("audio") else None,
                        "narration": scene["narration"], "duration": scene["duration"]} for scene in spec["scenes"]]}


def revise(project: Path, project_id: str, body: dict) -> object:
    request_id = body.get("requestId", "")
    if not isinstance(request_id, str) or not HASH.fullmatch(request_id):
        raise ValueError("A stable manifest key is required")
    manifest_path = local_path(body.get("manifestPath"))
    if manifest_path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("Manifest exceeded its limit")
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("project_id") != project_id:
        raise ValueError("Manifest belongs to another project")
    expected = manifest_contract(manifest, manifest_path.parent)
    project.mkdir(parents=True, exist_ok=True)
    with (project / ".studio-revise.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        receipt_path = project / "studio-receipts" / f"{request_id}.json"
        if receipt_path.exists():
            receipt = json.loads(receipt_path.read_text())
            if receipt["contract"] != expected:
                raise ValueError("Manifest key was reused with different prepared inputs")
            spec = json.loads((project / "revisions" / receipt["revision_id"] / "spec.json").read_text())
            if spec_contract(spec) != expected:
                raise ValueError("Saved upstream revision no longer matches the prepared inputs")
            return spec
        # A crash after revise but before its receipt is recoverable from the immutable spec.
        candidates = list((project / "revisions").glob("*/spec.json"))
        for candidate in candidates:
            spec = json.loads(candidate.read_text())
            if spec_contract(spec) == expected:
                # plan validates source snapshot hashes and the pinned toolchain.
                cli(project, "plan", ["--revision", spec["revision_id"]])
                atomic_json(receipt_path, {"revision_id": spec["revision_id"], "contract": expected})
                return spec
        result = cli(project, "revise", [str(manifest_path)])
        if not isinstance(result, dict) or spec_contract(result) != expected:
            raise ValueError("Upstream revise returned a mismatched prepared snapshot")
        atomic_json(receipt_path, {"revision_id": result["revision_id"], "contract": expected})
        return result


class Handler(BaseHTTPRequestHandler):
    server_version = "StudioRenderer/1"

    def log_message(self, format: str, *args: object) -> None:
        # Avoid HTTP headers, query strings and credential-bearing payloads in logs.
        sys.stderr.write(f"renderer request status: {args[1] if len(args) > 1 else 'unknown'}\n")

    def respond(self, status: int, value: object) -> None:
        encoded = json.dumps(value, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self) -> None:
        if self.path != "/health":
            self.respond(404, {"error": "Not found"})
            return
        try:
            subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True, timeout=10)
            subprocess.run([sys.executable, "-m", UPSTREAM_MODULE, "--help"], capture_output=True, check=True, timeout=10)
            self.respond(200, {"ready": True, "renderer": "MoneyPrinterTurbo", "version": "1.3.8", "contract": "video-project"})
        except (OSError, subprocess.SubprocessError):
            self.respond(503, {"ready": False})

    def do_POST(self) -> None:
        if TOKEN and not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {TOKEN}"):
            self.respond(401, {"error": "Internal renderer authentication required"})
            return
        match = re.fullmatch(r"/projects/([^/]+)/(revise|plan|render|status|cancel)", self.path)
        if not match or not UUID.fullmatch(match[1]):
            self.respond(404, {"error": "Unknown renderer operation"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 2 * 1024 * 1024:
                raise ValueError("A bounded JSON request is required")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("A JSON object is required")
            project_id, command = match.groups()
            project = PROJECT_ROOT / project_id
            allowed = {"manifestPath", "requestId"} if command == "revise" else {"revision", "retry"}
            if set(body) - allowed:
                raise ValueError("Unknown renderer request fields")
            if command == "revise":
                result = revise(project, project_id, body)
            else:
                revision = body.get("revision", "")
                if not isinstance(revision, str) or not REVISION.fullmatch(revision):
                    raise ValueError("An explicit upstream revision is required")
                arguments = ["--revision", revision]
                if command == "render":
                    if body.get("retry") is not True:
                        raise ValueError("Render retry intent must be explicit")
                    arguments += ["--retry", "--stage-timeout", "600"]
                result = cli(project, command, arguments)
            self.respond(200, result)
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
            sys.stderr.write(f"Renderer operation rejected: {type(error).__name__}: {str(error).replace(str(DATA_ROOT), chr(60) + 'data' + chr(62))[:1000]}\n")
            self.respond(422, {"error": "Prepared-media renderer operation failed; inspect service diagnostics"})


if __name__ == "__main__":
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((os.environ.get("STUDIO_RENDERER_HOST", "0.0.0.0"), int(os.environ.get("STUDIO_RENDERER_PORT", "8900"))), Handler)
    server.daemon_threads = True
    server.serve_forever()
