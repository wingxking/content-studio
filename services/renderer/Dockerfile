ARG PYTHON_IMAGE=mirror.gcr.io/library/python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c
FROM ${PYTHON_IMAGE}
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 install -y --no-install-recommends ffmpeg fonts-noto-cjk ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/mpt
RUN mkdir -p app/services && touch app/__init__.py app/services/__init__.py \
    && curl --fail --silent --show-error --location --connect-timeout 15 --max-time 90 --retry 3 https://raw.githubusercontent.com/harry0703/MoneyPrinterTurbo/v1.3.8/app/services/video_project.py -o app/services/video_project.py \
    && echo '96bca8c758ef7a6c83cfdbb42b6afbd8af94341251c6fd4822aa6705abbc61c4  app/services/video_project.py' | sha256sum -c -
ARG STUDIO_UID=1000
ARG STUDIO_GID=1000
RUN if ! getent group "$STUDIO_GID" >/dev/null; then groupadd --gid "$STUDIO_GID" studio; fi \
    && useradd --uid "$STUDIO_UID" --gid "$STUDIO_GID" --create-home studio \
    && mkdir /data && chown "$STUDIO_UID:$STUDIO_GID" /data
COPY services/renderer/server.py /opt/renderer/server.py
COPY services/renderer/UPSTREAM-LICENSE.txt /opt/mpt/LICENSE
USER studio
ENV STUDIO_DATA_DIR=/data STUDIO_RENDERER_PORT=8900 PYTHONUNBUFFERED=1
EXPOSE 8900
HEALTHCHECK --interval=30s --timeout=15s --start-period=15s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8900/health', timeout=12)"
CMD ["python", "/opt/renderer/server.py"]
