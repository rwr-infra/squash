FROM node:24-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run typecheck

FROM builder AS frontend-builder

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/vite.config.ts ./
COPY frontend/tsconfig.json ./
COPY frontend/index.html ./
COPY frontend/src ./src

ARG DOCKER_BUILD=1
RUN VITE_DOCKER_BUILD=1 npm run build


FROM node:24-slim AS runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash squash
USER squash

COPY --from=builder --chown=squash:squash /app/node_modules ./node_modules
COPY --from=builder --chown=squash:squash /app/src ./src
COPY --from=builder --chown=squash:squash /app/tsconfig.json .
COPY --from=builder --chown=squash:squash /app/package.json .
COPY --from=builder --chown=squash:squash /app/scripts ./scripts
COPY --from=frontend-builder --chown=squash:squash /app/frontend/dist ./frontend/dist
COPY --from=builder --chown=squash:squash /app/config ./config

ENV PORT=3000
ENV HOST=0.0.0.0
ENV SQUASH_STATIC_DIR=/app/frontend/dist

EXPOSE 3000

ENTRYPOINT ["tini", "--"]
CMD ["npx", "tsx", "src/index.ts"]
