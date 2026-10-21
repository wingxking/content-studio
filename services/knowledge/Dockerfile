ARG PYTHON_IMAGE=mirror.gcr.io/library/python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c
FROM ${PYTHON_IMAGE} AS dependencies
COPY --from=ghcr.io/astral-sh/uv:0.13.1@sha256:4a1f3666816dafadd20ceb71eac9a7d56d7ef30279f7d64048519ab901ada336 /uv /usr/local/bin/uv
USER root
ARG STUDIO_EMBED_REVISION=614241f622f53c4eeff9890bdc4f31cfecc418b3
ARG STUDIO_KNOWLEDGE_ENV=/service/.venv
ENV UV_PROJECT_ENVIRONMENT=${STUDIO_KNOWLEDGE_ENV} UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy UV_HTTP_TIMEOUT=120 UV_CONCURRENT_DOWNLOADS=16
ENV PATH="${STUDIO_KNOWLEDGE_ENV}/bin:${PATH}"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=2 TOKENIZERS_PARALLELISM=false STUDIO_KNOWLEDGE_CACHE=/models STUDIO_EMBED_REVISION=${STUDIO_EMBED_REVISION} HF_HOME=/tmp/huggingface HF_HUB_DISABLE_XET=1 HF_HUB_DISABLE_TELEMETRY=1
WORKDIR /service
ARG STUDIO_SYSTEM_DEPS=install
ARG STUDIO_APT_ORIGIN=https://deb.debian.org
RUN if [ "$STUDIO_SYSTEM_DEPS" = install ]; then case "$STUDIO_APT_ORIGIN" in https://deb.debian.org|https://mirrors.tuna.tsinghua.edu.cn) ;; *) exit 1;; esac; sed -i "s|http://deb.debian.org|$STUDIO_APT_ORIGIN|g" /etc/apt/sources.list.d/debian.sources && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 libgomp1 ca-certificates && rm -rf /var/lib/apt/lists/*; fi
COPY pyproject.toml uv.lock ./
COPY sync.py ./
ARG STUDIO_PYPI_MIRROR=
RUN --mount=type=cache,target=/root/.cache/uv STUDIO_PYPI_MIRROR=${STUDIO_PYPI_MIRROR} python sync.py
FROM dependencies AS runtime
COPY preload.py export_models.py models.lock.json ./
RUN --mount=type=cache,id=studio-evidence-models-v1,target=/var/cache/studio-models,sharing=locked STUDIO_KNOWLEDGE_CACHE=/var/cache/studio-models python preload.py && python export_models.py /var/cache/studio-models /models
COPY server.py ./
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
USER 1000:1000
EXPOSE 8920
CMD ["python", "server.py"]
