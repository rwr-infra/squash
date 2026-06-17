# --- Compile the TypeScript server to dist/ ---------------------------------
FROM node:24-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build:server

# --- Build the frontend ------------------------------------------------------
FROM node:24-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
ARG DOCKER_BUILD=1
RUN VITE_DOCKER_BUILD=1 npm run build

# --- Production-only dependencies (includes node-pty's linux binary) ---------
FROM node:24-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# --- Runtime -----------------------------------------------------------------
FROM node:24-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash squash
USER squash

COPY --from=deps --chown=squash:squash /app/node_modules ./node_modules
COPY --from=builder --chown=squash:squash /app/dist ./dist
COPY --from=builder --chown=squash:squash /app/package.json ./package.json
COPY --from=frontend-builder --chown=squash:squash /app/frontend/dist ./frontend/dist

ENV PORT=3000
ENV HOST=0.0.0.0
ENV SQUASH_STATIC_DIR=/app/frontend/dist

EXPOSE 3000

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
