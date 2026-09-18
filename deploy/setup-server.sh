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
#               www.paolosaxton.com con la ruta /bingomusical/ y pide el certificado con certbot.
#               "https": fuerza Caddy.  "": solo la app en 127.0.0.1:8080 (configura tú el proxy).

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
log "Construyendo y arrancando los contenedores"
if [ -n "$PROFILE" ]; then
  docker compose --profile "$PROFILE" up -d --build --remove-orphans
else
  docker compose up -d --build --remove-orphans
fi
docker image prune -f >/dev/null

# 8. Si hay un nginx o Apache, añadir el sitio www.paolosaxton.com -> app
APP_PORT="$(grep -s '^APP_PORT=' .env | cut -d= -f2- || true)"
APP_PORT="$APP_PORT"
if [ -d /etc/nginx/sites-available ]; then
  NGINX_SITE="/etc/nginx/sites-available/paolosaxton.com.conf"
else
  NGINX_SITE="/etc/nginx/conf.d/paolosaxton.com.conf"
fi
APACHE_SITE="/etc/apache2/sites-available/paolosaxton.com.conf"

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
# Bingo musical (generado por deploy/setup-server.sh). La app corre en 127.0.0.1:$APP_PORT.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN paolosaxton.com;

    location = /bingomusical {
        return 301 /bingomusical/;
    }

    location /bingomusical/ {
        proxy_pass http://127.0.0.1:$APP_PORT/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Raíz del dominio: de momento va al bingo. Sustituye este bloque por tu web.
    location / {
        return 302 /bingomusical/;
    }
}
NGINX
    if [ -d /etc/nginx/sites-enabled ]; then
      ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/paolosaxton.com.conf
    fi
    if ! nginx -t; then
      rm -f /etc/nginx/sites-enabled/paolosaxton.com.conf "$NGINX_SITE"
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
    certbot --nginx -d "$DOMAIN" -d paolosaxton.com --redirect $(certbot_args)
  fi
}

configure_apache() {
  log "Configurando el sitio en el Apache existente"
  a2enmod -q proxy proxy_http headers rewrite >/dev/null
  if [ ! -f "$APACHE_SITE" ]; then
    cat > "$APACHE_SITE" <<APACHE
# Bingo musical (generado por deploy/setup-server.sh). La app corre en 127.0.0.1:$APP_PORT.
<VirtualHost *:80>
    ServerName $DOMAIN
    ServerAlias paolosaxton.com

    RedirectMatch 301 ^/bingomusical$ /bingomusical/
    ProxyPreserveHost On
    ProxyPass        /bingomusical/ http://127.0.0.1:$APP_PORT/
    ProxyPassReverse /bingomusical/ http://127.0.0.1:$APP_PORT/

    # Raíz del dominio: de momento va al bingo. Sustituye esta línea por tu web.
    RedirectMatch 302 ^/$ /bingomusical/
</VirtualHost>
APACHE
    a2ensite -q paolosaxton.com.conf >/dev/null
    if ! apachectl configtest; then
      a2dissite -q paolosaxton.com.conf >/dev/null; rm -f "$APACHE_SITE"
      echo "La configuración de Apache no valida; se ha retirado el sitio nuevo sin tocar nada más." >&2
      exit 1
    fi
    systemctl reload apache2
  fi
  if [ ! -f "/etc/apache2/sites-available/paolosaxton.com-le-ssl.conf" ]; then
    log "Pidiendo el certificado HTTPS con certbot"
    command -v certbot >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq certbot python3-certbot-apache; }
    dpkg -s python3-certbot-apache >/dev/null 2>&1 || apt-get install -y -qq python3-certbot-apache
    # shellcheck disable=SC2046
    certbot --apache -d "$DOMAIN" -d paolosaxton.com --redirect $(certbot_args)
  fi
}

case "$web_server" in
  nginx) configure_nginx ;;
  apache) configure_apache ;;
  docker|other)
    printf '\n\033[1;33mAVISO:\033[0m los puertos 80/443 los ocupa un servidor que no sé configurar automáticamente:\n%s\n' "$listener"
    echo "La app está en 127.0.0.1:$APP_PORT. Añade en ese servidor el sitio $DOMAIN con la ruta"
    echo "/bingomusical/ -> http://127.0.0.1:$APP_PORT/ (ejemplo en deploy/nginx-site.example.conf)."
    ;;
esac

log "Listo. La app estará en $APP_URL en cuanto el DNS y el certificado estén activos."
echo "Registra $APP_URL como Redirect URI en https://developer.spotify.com/dashboard"
if [ -n "$PROFILE" ]; then
  echo "Logs: docker compose -f $APP_DIR/docker-compose.yml --profile $PROFILE logs -f"
else
  echo "Logs: docker compose -f $APP_DIR/docker-compose.yml logs -f"
fi
