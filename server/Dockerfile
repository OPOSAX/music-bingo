# syntax=docker/dockerfile:1.6
# Servidor Concert (Biznet Crowd Mic): app estática + señalización + SFU mediasoup (núcleo de B-Talk).
FROM node:20-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm ci --no-audit --no-fund && npm run build
ARG APP_VERSION=dev
RUN echo "$APP_VERSION" > public/version.txt

FROM node:20-slim AS deps
WORKDIR /srv/server
# Binario precompilado del worker (rápido). Para compilarlo en la imagen como hace B-Talk: MEDIASOUP_SKIP_WORKER_PREBUILT_DOWNLOAD=true.
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 python3-pip ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:20-slim AS runtime
ENV NODE_ENV=production PORT=3010
WORKDIR /srv
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 concert && useradd --system --uid 1001 --gid concert --home-dir /srv --shell /usr/sbin/nologin concert
COPY --from=build --chown=concert:concert /src/public ./public
COPY --from=deps --chown=concert:concert /srv/server/node_modules ./server/node_modules
COPY --chown=concert:concert server ./server
USER concert
EXPOSE 3010/tcp
EXPOSE 40000-40100/udp
EXPOSE 40000-40100/tcp
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fs http://127.0.0.1:${PORT}/health || exit 1
CMD ["node", "server/concert-server.mjs"]
