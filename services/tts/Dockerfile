ARG TTS_IMAGE=ghcr.io/remsky/kokoro-fastapi-cpu:v0.9.0@sha256:ee3111d6a2c903ed62f3b4fa19543c6901205ed39fce3c177e895b34a8386b9c
FROM ${TTS_IMAGE}
USER root
ARG STUDIO_UID=1000
ARG STUDIO_GID=1000
RUN if ! getent group "$STUDIO_GID" >/dev/null; then groupmod --gid "$STUDIO_GID" appuser; fi \
    && usermod --gid "$STUDIO_GID" appuser \
    && if [ "$STUDIO_UID" != "1000" ]; then usermod --uid "$STUDIO_UID" appuser; fi \
    && mkdir /tts-cache && chown "$STUDIO_UID:$STUDIO_GID" /tts-cache
COPY services/tts/start.py /opt/studio-tts/start.py
USER appuser
ENV STUDIO_TTS_CACHE_DIR=/tts-cache USE_GPU=false DEVICE=cpu DOWNLOAD_MODEL=false PORT=8880
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8880/health', timeout=8)"
CMD ["python", "/opt/studio-tts/start.py"]
