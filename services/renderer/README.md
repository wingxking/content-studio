# Prepared media renderer

This Linux service executes MoneyPrinterTurbo v1.3.8's prepared-media `video-project` CLI with a SHA-256 checked source file. That upstream module uses Python's standard library and FFmpeg; the full MoneyPrinterTurbo WebUI/provider dependencies are unnecessary for this endpoint. The digest-pinned Python 3.12.12 base manifest includes ARM64 and AMD64 platforms. `PYTHON_IMAGE` can select an operator-verified mirror/digest at build time. Build with repository root as context:

```sh
docker build -f services/renderer/Dockerfile --build-arg STUDIO_UID=1000 --build-arg STUDIO_GID=1000 -t studio-renderer .
```

Mount the same non-synced persistent root at the **same absolute container path** for the video worker and renderer. Set `STUDIO_DATA_DIR` to that path. Publish no renderer port outside the Compose internal network; `STUDIO_RENDERER_PORT` controls the internal listener. An optional `STUDIO_RENDERER_TOKEN` secures internal calls and must come from a private environment/secret, never tracked configuration.

`STUDIO_RENDERER_URL=http://renderer:8900` selects this service. CPU TTS is a separate Kokoro-FastAPI v0.9.0 service selected by `STUDIO_TTS_URL=http://tts:8880`. Set `STUDIO_TTS_FINGERPRINT` to an immutable deployed image/model/voice revision. The video worker requires FFmpeg/FFprobe, libass and Noto CJK fonts for sentence measurement, footage preparation, caption burning and final decode checks. Runtime services and these tools execute in Docker; this adapter has no macOS `say`, host Python or host renderer fallback.

The wrapper exposes `POST /projects/{uuid}/{revise,plan,render,status,cancel}` using bounded JSON and fixed CLI arguments. `revise` accepts only `manifestPath` inside the shared root and a stable SHA-256 `requestId`; other calls require an explicit upstream `revision`. Rendering requires `retry:true`. A project lock and saved receipt bind the input key to its immutable upstream revision. If the revise response is lost, reconciliation compares prepared source hashes against existing immutable specs before creating a new revision. MPT independently verifies source snapshots and cached artifact bytes.

Keep the renderer private. It accepts prepared local media only and has no database or platform credentials. Its manifests carry public narration, local hashes and media references. Cancellation stops upstream rendering; business result fencing remains the video worker's responsibility. Health checks verify the installed tools, not video quality, TTS intelligibility, publication permission or stage-one acceptance.
