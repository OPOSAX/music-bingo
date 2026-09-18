#!/usr/bin/env bash
# Instalación o actualización del bingo musical en el servidor (Ubuntu/Debian).
# Uso (como root o con sudo):
#   curl -fsSL https://raw.githubusercontent.com/OPOSAX/music-bingo/main/deploy/setup-server.sh | sudo bash
# o, si ya tienes el repositorio clonado:
#   sudo ./deploy/setup-server.sh
#
# Variables opcionales:
#   APP_DIR     ruta de instalación (por defecto /opt/music-bingo)
#   REPO_URL    repositorio a clonar (por defecto https://github.com/OPOSAX/music-bingo.git)
#   BRANCH      rama a desplegar (por defecto main)
#   ACME_EMAIL  correo para Let's Encrypt (se pide si no hay .env)
#   PROFILE     "https" (Caddy en 80/443), "" (solo la app en 127.0.0.1:8080, detrás de tu
#               propio nginx/Apache) o "auto" (por defecto: https si 80/443 están libres)

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/music-bingo}"
REPO_URL="${REPO_URL:-https://github.com/OPOSAX/music-bingo.git}"
BRANCH="${BRANCH:-main}"
DOMAIN="www.paolosaxton.com"
APP_URL="https://$DOMAIN/bingomusical/"
PROFILE="${PROFILE:-auto}"

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecuta este script como root (sudo)." >&2
  exit 1
fi

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  log "Instalando Docker"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi
if ! docker compose version >/dev/null 2>&1; then
  log "Instalando el plugin docker compose"
  apt-get update -qq && apt-get install -y -qq docker-compose-plugin
fi

# 2. Código
if [ -d "$APP_DIR/.git" ]; then
  log "Actualizando el repositorio en $APP_DIR"
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  log "Clonando el repositorio en $APP_DIR"
  command -v git >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git; }
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# 3. Configuración
if [ ! -f .env ]; then
  log "Creando .env"
  email="${ACME_EMAIL:-}"
  if [ -z "$email" ] && [ -t 0 ]; then
    read -r -p "Correo para los avisos de Let's Encrypt: " email
  fi
  cp .env.example .env
  sed -i "s/^ACME_EMAIL=.*/ACME_EMAIL=${email}/" .env
fi

# 4. Cortafuegos (si ufw está activo)
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  log "Abriendo los puertos 80 y 443 en ufw"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
fi

# 5. Comprobación de DNS (informativa)
server_ip="$(curl -fsS https://api.ipify.org 2>/dev/null || true)"
dns_ip="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -n1 || true)"
if [ -n "$server_ip" ] && [ "$dns_ip" != "$server_ip" ]; then
  printf '\n\033[1;33mAVISO:\033[0m %s resuelve a "%s" y este servidor es %s.\n' "$DOMAIN" "${dns_ip:-nada}" "$server_ip"
  echo "Caddy no podrá obtener el certificado hasta que el registro A apunte aquí."
fi

# 6. ¿Hay ya un servidor web en los puertos 80/443?
if [ "$PROFILE" = "auto" ]; then
  PROFILE="https"
  busy="$(ss -Hltn 'sport = :80 or sport = :443' 2>/dev/null | grep -v docker || true)"
  if [ -n "$busy" ] && ! docker compose ps --services --status running 2>/dev/null | grep -q caddy; then
    printf '\n\033[1;33mAVISO:\033[0m ya hay algo escuchando en los puertos 80/443:\n%s\n' "$busy"
    echo "Se arranca solo la app en 127.0.0.1:8080. Configura tu servidor web con deploy/nginx-site.example.conf"
    PROFILE=""
  fi
fi

# 7. Arrancar
log "Construyendo y arrancando los contenedores"
if [ -n "$PROFILE" ]; then
  docker compose --profile "$PROFILE" up -d --build --remove-orphans
else
  docker compose up -d --build --remove-orphans
fi
docker image prune -f >/dev/null

log "Listo. La app estará en $APP_URL en cuanto el DNS y el certificado estén activos."
echo "Registra $APP_URL como Redirect URI en https://developer.spotify.com/dashboard"
if [ -n "$PROFILE" ]; then
  echo "Logs: docker compose -f $APP_DIR/docker-compose.yml --profile $PROFILE logs -f"
else
  echo "Logs: docker compose -f $APP_DIR/docker-compose.yml logs -f"
fi
