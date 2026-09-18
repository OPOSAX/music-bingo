# syntax=docker/dockerfile:1

# ---- Etapa 1: compilar TypeScript y ejecutar las pruebas ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.test.json ./
COPY src ./src
COPY tests ./tests
COPY public ./public
RUN npm test && npm run build

# ---- Etapa 2: servir los archivos estáticos con nginx ----
FROM nginx:1.27-alpine AS runtime

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/public /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
