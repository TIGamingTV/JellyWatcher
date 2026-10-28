# syntax=docker/dockerfile:1.7
# JellyWatcher — single container serving the API, the web UI and background sync.

ARG NODE_VERSION=24

# ---- Build: install all dependencies, compile web + server ---------------------------------
# The output is plain JS/CSS, so it runs on the build host's platform (no emulation for multi-arch).
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
# Toolchain only used if a prebuilt better-sqlite3 binary is unavailable for the platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts ./
COPY scripts ./scripts
COPY shared ./shared
COPY server ./server
COPY web ./web
RUN npm run build

# ---- Production dependencies only ----------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- Runtime ---------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG VERSION=dev
LABEL org.opencontainers.image.title="JellyWatcher" \
      org.opencontainers.image.description="Self-hosted watchlist aggregator and media request hub for Jellyfin and Seerr" \
      org.opencontainers.image.source="https://github.com/TIGamingTV/JellyWatcher" \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      org.opencontainers.image.version="${VERSION}"

ENV NODE_ENV=production \
    JW_HOST=0.0.0.0 \
    JW_PORT=8484 \
    JW_DATA_DIR=/data \
    JW_WEB_DIR=/app/dist/web

WORKDIR /app
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root package.json ./

# Application files stay root-owned and read-only; only /data is writable by the app user.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8484

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.JW_PORT||8484)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "--enable-source-maps", "dist/server/index.js"]
