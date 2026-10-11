# CPU speech service

The wrapper extends the digest-pinned official Kokoro-FastAPI v0.9.0 CPU image. Its verified manifest includes Linux ARM64 and AMD64. It keeps upstream models/voices baked in the image and seeds a dedicated cache rather than mounting an empty directory over the baked model path.

Build from repository root with `docker build -f services/tts/Dockerfile -t content-studio-tts .`. Bind a private, non-synced writable directory to `/tts-cache` (configurable `STUDIO_TTS_CACHE_DIR`), owned by `STUDIO_UID`/`STUDIO_GID` used at build time. Internal listener defaults to port 8880; `PORT` and `HOST` are configurable. No public host port is needed.

Startup verifies cached models/voices against their baked SHA-256 hashes and records `/tts-cache/fingerprint.json`. Missing or damaged files are replaced atomically from the immutable image. Set the worker's `STUDIO_TTS_FINGERPRINT` to this model/voice fingerprint plus the pinned service image digest so upgrading either invalidates sentence audio reuse. Keep `/tts-cache` out of synced personal vaults and content exports. Hugging Face and language-processing runtime caches use dedicated subdirectories; their first initialization may require network access.

The service runs on CPU with debug, unload, voice-tag and SSML endpoints disabled. `/health` becomes available after upstream startup/warmup; a successful sentence WAV and listening review remain separate acceptance steps. Video captions use measured sentence WAV durations, never claimed Chinese word timestamps. `af_heart` and `zf_xiaobei` are configurable voice choices; Chinese intelligibility and platform synthetic-media disclosure require actual review. No macOS TTS fallback is configured.

Kokoro-FastAPI is Apache-2.0. The inherited image retains upstream and dependency licenses. Voice/model/dictionary licenses remain independent of the Studio wrapper; maintain the upstream lock and review them before distributing a product.
