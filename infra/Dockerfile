# One architecture-neutral application image; BuildKit selects ARM64 or AMD64 dependencies.
ARG NODE_IMAGE=mirror.gcr.io/library/node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
FROM ${NODE_IMAGE} AS application
RUN apt-get -o Acquire::Retries=5 update && apt-get -o Acquire::Retries=5 install -y --no-install-recommends ca-certificates && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && apt-get -o Acquire::Retries=5 update && apt-get -o Acquire::Retries=5 install -y --no-install-recommends ffmpeg librsvg2-bin fonts-noto-core fonts-noto-cjk ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY scripts ./scripts
COPY docs ./docs
COPY supabase/migrations ./supabase/migrations
COPY .agents/skills ./.agents/skills
RUN npm run build
ENV NODE_ENV=production STUDIO_DATA_DIR=/data STUDIO_LOCALFS_DIR=/data/media/localfs STUDIO_CONTAINER=true
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "src/server/index.ts"]

FROM application AS model
USER root
RUN npm install --global @openai/codex@0.162.1
ENV CODEX_HOME=/auth
USER node
CMD ["node", "--import", "tsx", "src/server/model-runner.ts"]

# Lifecycle utilities also run in Docker; the host needs Docker/Compose and a shell only.
FROM mirror.gcr.io/library/docker:28-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d AS operations
RUN apk add --no-cache nodejs
COPY scripts/docker.mjs /opt/content-studio/docker.mjs
ENTRYPOINT ["node", "/opt/content-studio/docker.mjs"]
