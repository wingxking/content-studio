"""Run inside the isolated renderer container; consumes real CPU TTS over HTTP."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
from uuid import uuid4

root = Path(os.environ.get("STUDIO_DATA_DIR", "/data"))
project_id = str(uuid4())
work = root / "acceptance" / project_id
work.mkdir(parents=True)
renderer = os.environ.get("RENDERER_ORIGIN", "http://127.0.0.1:8900")
tts = os.environ.get("TTS_ORIGIN", "http://studio-d5-tts:8880")


def post(origin: str, endpoint: str, body: dict) -> bytes:
    request = urllib.request.Request(origin + endpoint, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=180) as response:
        return response.read()


def command(*arguments: str) -> str:
    return subprocess.run(arguments, cwd=work, check=True, capture_output=True, text=True, timeout=180).stdout


def probe(path: Path) -> dict:
    return json.loads(command("ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", str(path)))


with urllib.request.urlopen(tts + "/health", timeout=10) as response:
    assert response.status == 200
started = time.monotonic()
english = "Save your work before closing the editor."
chinese = "关闭编辑器之前，请先保存工作。"
for name, text, voice in [("english", english, "af_heart"), ("chinese", chinese, "zf_xiaobei")]:
    audio = post(tts, "/v1/audio/speech", {"model": "kokoro", "input": text, "voice": voice, "speed": 1, "response_format": "wav", "stream": False})
    assert audio[:4] == b"RIFF" and audio[8:12] == b"WAVE"
    (work / f"{name}.wav").write_bytes(audio)
    measured = probe(work / f"{name}.wav")
    assert any(stream["codec_type"] == "audio" for stream in measured["streams"])
    assert 0 < float(measured["format"]["duration"]) < 30
command("ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x17383c:s=320x240:r=24", "-t", "1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(work / "footage.mp4"))
manifest = {"project_id": project_id, "settings": {"width": 320, "height": 240, "fps": 24, "narration_volume": 1.0, "bgm_volume": 0},
            "scenes": [{"id": "english", "footage": str(work / "footage.mp4"), "audio": str(work / "english.wav"), "narration": english},
                       {"id": "chinese", "footage": str(work / "footage.mp4"), "audio": str(work / "chinese.wav"), "narration": chinese}]}
manifest_path = work / "manifest.json"
manifest_path.write_text(json.dumps(manifest))
key = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
receipt = json.loads(post(renderer, f"/projects/{project_id}/revise", {"manifestPath": str(manifest_path), "requestId": key}))
revision = receipt["revision_id"]
plan = json.loads(post(renderer, f"/projects/{project_id}/plan", {"revision": revision}))
assert any(stage["action"] == "build" for stage in plan)
result = json.loads(post(renderer, f"/projects/{project_id}/render", {"revision": revision, "retry": True}))
assert result["state"] == "succeeded"
raw = Path(result["export"]["path"])
assert hashlib.sha256(raw.read_bytes()).hexdigest() == result["export"]["sha256"]
measured = probe(raw)
assert {stream["codec_type"] for stream in measured["streams"]} >= {"video", "audio"}
repeated = json.loads(post(renderer, f"/projects/{project_id}/render", {"revision": revision, "retry": True}))
assert repeated["state"] == "succeeded" and all(stage["reused"] for stage in repeated["stages"].values())
receipt_path = root / "renderers" / "mpt" / "projects" / project_id / "studio-receipts" / f"{key}.json"
receipt_path.unlink()
recovered = json.loads(post(renderer, f"/projects/{project_id}/revise", {"manifestPath": str(manifest_path), "requestId": key}))
assert recovered["revision_id"] == revision
english_duration = float(probe(work / "english.wav")["format"]["duration"])
chinese_duration = float(probe(work / "chinese.wav")["format"]["duration"])

def stamp(seconds: float) -> str:
    total = round(seconds * 1000)
    return f"{total // 3600000:02}:{total // 60000 % 60:02}:{total // 1000 % 60:02},{total % 1000:03}"

(work / "captions.srt").write_text(f"1\n{stamp(0)} --> {stamp(english_duration)}\n{english}\n\n2\n{stamp(english_duration)} --> {stamp(english_duration + chinese_duration)}\n{chinese}\n")
final = work / "captioned.mp4"
command("ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(raw), "-vf", "subtitles=filename=captions.srt:force_style='FontName=Noto Sans CJK SC,FontSize=18,MarginV=24'", "-map", "0:v:0", "-map", "0:a:0", "-c:v", "libx264", "-c:a", "copy", str(final))
command("ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-i", str(final), "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-")
final_probe = probe(final)
record = {"projectId": project_id, "upstreamRevision": revision, "realCpuTts": True, "voices": ["af_heart", "zf_xiaobei"],
          "englishSeconds": english_duration, "chineseSeconds": chinese_duration, "videoSeconds": float(final_probe["format"]["duration"]),
          "finalPath": str(final), "finalHash": hashlib.sha256(final.read_bytes()).hexdigest(), "cacheReuseStages": len(repeated["stages"]),
          "lostReceiptRecovered": True, "captionsBurned": True, "fullDecodePassed": True, "elapsedSeconds": round(time.monotonic() - started, 3),
          "listeningReview": "not performed", "publication": "not requested"}
(work / "acceptance.json").write_text(json.dumps(record, indent=2))
print(json.dumps(record, indent=2))
