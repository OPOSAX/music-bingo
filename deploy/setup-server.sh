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
#   PROFILE     "auto" (por defecto): Caddy si los puertos 80/443 están libres; si ya hay un
#               nginx o Apache sirviendo otros sitios, añade a ese servidor el sitio
#               www.bingohit.cl con la ruta /sistema/ y pide el certificado con certbot.
#               "https": fuerza Caddy.  "": solo el servidor en 127.0.0.1:3010 (configura tú el proxy).
#
# El sistema completo (app, API de la plataforma, Socket.IO y WebRTC/mediasoup) lo sirve el
# servidor Concert (perfil "concert" de docker compose) en el puerto local 3010.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/music-bingo}"
REPO_URL="${REPO_URL:-https://github.com/OPOSAX/music-bingo.git}"
BRANCH="${BRANCH:-main}"
DOMAIN="www.bingohit.cl"
BASE_PATH="/sistema"
APP_URL="https://$DOMAIN$BASE_PATH/"
PROFILE="${PROFILE:-auto}"

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecuta este script como root (sudo)." >&2
  exit 1
fi

# 0. Utilidades básicas
for tool in curl git; do
  command -v "$tool" >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq "$tool"; }
done

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
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# 3. Configuración
if [ ! -f .env ]; then
  log "Creando .env"
  email="${ACME_EMAIL:-}"
  if [ -z "$email" ] && [ -t 0 ]; then
    read -r -p "Correo para los avisos de Let's Encrypt (opcional): " email
  fi
  cp .env.example .env
  sed -i "s/^ACME_EMAIL=.*/ACME_EMAIL=${email}/" .env
fi

# 3b. Secretos y direcciones del servidor Concert/plataforma (se generan una sola vez)
set_env() { # clave valor
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
env_value() { grep -s "^$1=" .env | cut -d= -f2- || true; }
gen_secret() { tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32; }
for key in PLATFORM_ADMIN_TOKEN PLATFORM_ADMIN_PASSWORD LIVE_HOST_TOKEN CONCERT_DJ_TOKEN MOCK_PAYMENT_SECRET; do
  v="$(env_value "$key")"
  case "$v" in ""|cambia-*) set_env "$key" "$(gen_secret)" ;; esac
done
set_env PUBLIC_URL "$APP_URL"
set_env CONCERT_PORT 3010
public_ip="$(curl -fsS https://api.ipify.org 2>/dev/null || true)"
[ -n "$public_ip" ] && set_env BTALK_ANNOUNCED_IP "$public_ip"


# 4. Cortafuegos (si ufw está activo)
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  log "Abriendo los puertos 80 y 443 en ufw"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  # WebRTC (mediasoup)
  ufw allow 40000:40100/udp >/dev/null
  ufw allow 40000:40100/tcp >/dev/null
fi

# 5. Comprobación de DNS (informativa)
server_ip="$(curl -fsS https://api.ipify.org 2>/dev/null || true)"
dns_ip="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -n1 || true)"
if [ -n "$server_ip" ] && [ "$dns_ip" != "$server_ip" ]; then
  printf '\n\033[1;33mAVISO:\033[0m %s resuelve a "%s" y este servidor es %s.\n' "$DOMAIN" "${dns_ip:-nada}" "$server_ip"
  echo "Caddy no podrá obtener el certificado hasta que el registro A apunte aquí."
fi

# 6. ¿Hay ya un servidor web en los puertos 80/443?
listener="$(ss -Hltnp 'sport = :80 or sport = :443' 2>/dev/null || true)"
web_server="none"
if [ -n "$listener" ]; then
  if docker compose ps --services --status running 2>/dev/null | grep -q '^caddy$'; then
    web_server="own-caddy"   # nuestro propio Caddy de una ejecución anterior
  elif echo "$listener" | grep -q 'nginx'; then web_server="nginx"
  elif echo "$listener" | grep -qE 'apache2|httpd'; then web_server="apache"
  elif echo "$listener" | grep -q 'docker'; then web_server="docker"
  else web_server="other"
  fi
fi

if [ "$PROFILE" = "auto" ]; then
  case "$web_server" in
    none|own-caddy) PROFILE="https" ;;
    *) PROFILE="" ;;
  esac
fi
if [ "$PROFILE" = "https" ] && [ "$web_server" != "none" ] && [ "$web_server" != "own-caddy" ]; then
  printf '\n\033[1;31mERROR:\033[0m no se puede usar Caddy: ya hay algo en los puertos 80/443 (%s).\n' "$web_server" >&2
  echo "$listener" >&2
  exit 1
fi

# 7. Arrancar
log "Construyendo y arrancando los contenedores (la primera vez compila mediasoup: varios minutos)"
if [ "$PROFILE" = "https" ]; then
  docker compose --profile https up -d --build --remove-orphans
else
  docker compose --profile concert up -d --build --remove-orphans
fi
docker image prune -f >/dev/null

# 8. Si hay un nginx o Apache, añadir el sitio www.bingohit.cl/sistema -> servidor Concert
APP_PORT="$(env_value CONCERT_PORT)"
APP_PORT="${APP_PORT:-3010}"
if [ -d /etc/nginx/sites-available ]; then
  NGINX_SITE="/etc/nginx/sites-available/bingohit.cl.conf"
else
  NGINX_SITE="/etc/nginx/conf.d/bingohit.cl.conf"
fi
APACHE_SITE="/etc/apache2/sites-available/bingohit.cl.conf"

certbot_args() {
  if [ -n "$(grep -s '^ACME_EMAIL=' .env | cut -d= -f2-)" ]; then
    echo "--non-interactive --agree-tos -m $(grep '^ACME_EMAIL=' .env | cut -d= -f2-)"
  else
    echo "--non-interactive --agree-tos --register-unsafely-without-email"
  fi
}

configure_nginx() {
  log "Configurando el sitio en el nginx existente"
  if [ ! -f "$NGINX_SITE" ]; then
    cat > "$NGINX_SITE" <<NGINX
# Bingo Hit (generado por deploy/setup-server.sh). El sistema corre en 127.0.0.1:$APP_PORT.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN bingohit.cl;

    location = $BASE_PATH {
        return 301 $BASE_PATH/;
    }

    location $BASE_PATH/ {
        proxy_pass http://127.0.0.1:$APP_PORT/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
    }

    # Raíz del dominio: de momento va al sistema. Sustituye este bloque por tu web.
    location / {
        return 302 $BASE_PATH/;
    }
}
NGINX
    if [ -d /etc/nginx/sites-enabled ]; then
      ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/bingohit.cl.conf
    fi
    if ! nginx -t; then
      rm -f /etc/nginx/sites-enabled/bingohit.cl.conf "$NGINX_SITE"
      echo "La configuración de nginx no valida; se ha retirado el sitio nuevo sin tocar nada más." >&2
      exit 1
    fi
    systemctl reload nginx
  fi
  if ! grep -q 'listen 443' "$NGINX_SITE"; then
    log "Pidiendo el certificado HTTPS con certbot"
    command -v certbot >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq certbot python3-certbot-nginx; }
    dpkg -s python3-certbot-nginx >/dev/null 2>&1 || apt-get install -y -qq python3-certbot-nginx
    # shellcheck disable=SC2046
    certbot --nginx -d "$DOMAIN" -d bingohit.cl --redirect $(certbot_args)
  fi
}

configure_apache() {
  log "Configurando el sitio en el Apache existente"
  a2enmod -q proxy proxy_http proxy_wstunnel headers rewrite >/dev/null
  if [ ! -f "$APACHE_SITE" ]; then
    cat > "$APACHE_SITE" <<APACHE
# Bingo Hit (generado por deploy/setup-server.sh). El sistema corre en 127.0.0.1:$APP_PORT.
<VirtualHost *:80>
    ServerName $DOMAIN
    ServerAlias bingohit.cl

    RedirectMatch 301 ^$BASE_PATH$ $BASE_PATH/
    ProxyPreserveHost On
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteRule ^$BASE_PATH/(.*) ws://127.0.0.1:$APP_PORT/\$1 [P,L]
    ProxyPass        $BASE_PATH/ http://127.0.0.1:$APP_PORT/
    ProxyPassReverse $BASE_PATH/ http://127.0.0.1:$APP_PORT/

    # Raíz del dominio: de momento va al sistema. Sustituye esta línea por tu web.
    RedirectMatch 302 ^/$ $BASE_PATH/
</VirtualHost>
APACHE
    a2ensite -q bingohit.cl.conf >/dev/null
    if ! apachectl configtest; then
      a2dissite -q bingohit.cl.conf >/dev/null; rm -f "$APACHE_SITE"
      echo "La configuración de Apache no valida; se ha retirado el sitio nuevo sin tocar nada más." >&2
      exit 1
    fi
    systemctl reload apache2
  fi
  if [ ! -f "/etc/apache2/sites-available/bingohit.cl-le-ssl.conf" ]; then
    log "Pidiendo el certificado HTTPS con certbot"
    command -v certbot >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq certbot python3-certbot-apache; }
    dpkg -s python3-certbot-apache >/dev/null 2>&1 || apt-get install -y -qq python3-certbot-apache
    # shellcheck disable=SC2046
    certbot --apache -d "$DOMAIN" -d bingohit.cl --redirect $(certbot_args)
  fi
}

case "$web_server" in
  nginx) configure_nginx ;;
  apache) configure_apache ;;
  docker|other)
    printf '\n\033[1;33mAVISO:\033[0m los puertos 80/443 los ocupa un servidor que no sé configurar automáticamente:\n%s\n' "$listener"
    echo "El sistema está en 127.0.0.1:$APP_PORT. Añade en ese servidor el sitio $DOMAIN con la ruta"
    echo "$BASE_PATH/ -> http://127.0.0.1:$APP_PORT/ con soporte de websocket (ejemplo en deploy/nginx-site.example.conf)."
    ;;
esac

log "Listo. El sistema estará en $APP_URL en cuanto el DNS y el certificado estén activos."
echo "Registra $APP_URL como Redirect URI en https://developer.spotify.com/dashboard"
echo
echo "Accesos (guárdalos; también están en $APP_DIR/.env):"
echo "  Iniciar sesión (#/login): usuario admin · contraseña $(env_value PLATFORM_ADMIN_PASSWORD)"
echo "  Token API del administrador:       $(env_value PLATFORM_ADMIN_TOKEN)"
echo "  Animador Live / DJ (#/live, #/dj): $(env_value LIVE_HOST_TOKEN)"
echo
echo "Comprobación: curl -s ${APP_URL}health"
if [ "$PROFILE" = "https" ]; then
  echo "Logs: docker compose -f $APP_DIR/docker-compose.yml --profile https logs -f"
else
  echo "Logs: docker compose -f $APP_DIR/docker-compose.yml --profile concert logs -f"
fi
