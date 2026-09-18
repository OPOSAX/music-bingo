# 🎵 Bingo musical con Spotify Premium

Aplicación web para organizar un **bingo musical** con cualquier lista de Spotify.
El anfitrión inicia sesión con su cuenta **Spotify Premium**, elige una lista, la app
genera las tarjetas y va reproduciendo fragmentos de las canciones. Los jugadores
reciben su tarjeta por enlace (o impresa) y la marcan desde el móvil sin necesitar
cuenta de Spotify.

Funciona íntegramente en el navegador: **sin backend, sin base de datos y sin
dependencias en tiempo de ejecución**. Solo hace falta un servidor de archivos estáticos.

## Características

- **Inicio de sesión con Spotify** mediante Authorization Code + PKCE (no se necesita client secret).
- **Reproducción en el navegador** con el Spotify Web Playback SDK, o en cualquier otro
  dispositivo donde tengas Spotify abierto (altavoz, móvil, ordenador).
- **Fragmentos configurables**: duración (3–120 s) y punto de inicio (aleatorio, hacia la
  mitad o desde el principio). La app pausa la canción automáticamente.
- **Tarjetas 3×3, 4×4 o 5×5**, con casilla central libre opcional; hasta 500 tarjetas por partida.
- **Tarjetas deterministas**: se generan a partir del código de partida, así que el anfitrión
  puede **comprobar cualquier tarjeta por su número** y ver si tiene línea o bingo.
- **Reparto por QR sin servidor**: cada tarjeta tiene un enlace autocontenido (comprimido)
  y su **código QR**. La pantalla *Repartir con QR* muestra los QR en grande de uno en uno
  para que cada jugador escanee el suyo; las tarjetas impresas también llevan su QR, y el
  enlace se puede copiar o compartir con la hoja nativa del móvil.
- **Vista de jugador**: toca para marcar, detección automática de línea y bingo, marcas
  guardadas en el dispositivo.
- **Pantalla del anfitrión**: canción oculta hasta que la reveles, historial, contador,
  tarjetas con línea/bingo en tiempo real, deshacer y reanudar la partida tras recargar.
- Interfaz en español, diseño responsive y hoja de estilos de impresión.

## Requisitos

- Cuenta **Spotify Premium** para el anfitrión (los jugadores no necesitan nada).
- Docker (o Node.js 18+ si prefieres ejecutarlo sin contenedor).
- Navegador de escritorio con soporte del Web Playback SDK (Chrome, Edge, Firefox o Safari).

## Puesta en marcha

### 1. Crea una app en el panel de Spotify

1. Entra en <https://developer.spotify.com/dashboard> y pulsa **Create app**.
2. Nombre y descripción a tu gusto.
3. En **Redirect URIs** añade exactamente `http://127.0.0.1:8888/`
   (Spotify no admite `localhost`; si despliegas la app en otra URL, añade también esa URL con `https://`).
4. En **APIs used** marca **Web API** y **Web Playback SDK**. Guarda.
5. Copia el **Client ID**.

> Las apps nuevas están en *modo desarrollo*: solo pueden usarlas los usuarios que añadas
> en **User Management** del panel. Añade ahí tu propia cuenta Premium. Los jugadores no
> inician sesión, así que no hace falta añadirlos.

### 2. Arranca con Docker (recomendado)

```bash
docker compose --profile dev up
```

Abre <http://127.0.0.1:8888/>, pega el Client ID y pulsa **Conectar con Spotify**.
El contenedor de desarrollo instala las dependencias, recompila al guardar y sirve `public/`.

Sin Docker también funciona (necesita Node.js 18+):

```bash
npm install
npm run dev
```

Otros comandos:

| Comando             | Qué hace                                                     |
| ------------------- | ------------------------------------------------------------ |
| `npm run build`     | Compila `src/` (TypeScript) a `public/js/`                   |
| `npm run watch`     | Recompila al guardar                                         |
| `npm start`         | Sirve `public/` en `http://127.0.0.1:8888/` (sin recompilar) |
| `npm run dev`       | Servidor + recompilación automática                          |
| `npm test`          | Pruebas unitarias (lógica de bingo, enlaces, API)            |

Variables opcionales: `PORT` (por defecto 8888) y `HOST` (por defecto `127.0.0.1`).

## Cómo se juega

1. **Nueva partida**: elige una de tus listas o pega la URL de cualquier lista pública,
   ajusta tamaño de tarjeta, número de tarjetas y duración del fragmento, y pulsa
   **Crear partida**. Se necesitan al menos tantas canciones como casillas (se recomienda el doble).
2. **Reparte las tarjetas** con *Repartir con QR*: la pantalla muestra el QR de la tarjeta 1
   en grande; el primer jugador lo escanea con la cámara del móvil, pulsas *Siguiente*
   (o la flecha derecha) y así sucesivamente. También puedes imprimirlas (llevan su QR) o
   enviar el enlace de cada tarjeta (*Copiar enlace* o *Compartir…*). Cada tarjeta tiene un
   código `PARTIDA-Nº`.
3. En la pantalla del anfitrión pulsa **Usar este navegador** (o elige otro dispositivo de
   Spotify) y luego **Empezar**. Cada pulsación de **Siguiente canción** reproduce un
   fragmento y se para sola. Puedes **repetir** el fragmento y **revelar** el título cuando quieras.
4. Los jugadores tocan en su tarjeta las canciones que reconocen. Cuando alguien canta
   línea o bingo, escribe su número de tarjeta en **Comprobar una tarjeta** y la app te
   dice si es válida según las canciones que han sonado de verdad.

## Despliegue en un servidor (OVH, VPS, etc.)

La imagen de producción (`Dockerfile`) compila el proyecto, ejecuta las pruebas y sirve la
app con nginx. Todo se orquesta con `docker-compose.yml`.

### Con HTTPS automático (Caddy + Let's Encrypt)

Spotify exige `https://` en el Redirect URI para cualquier host que no sea `127.0.0.1`,
así que necesitas un dominio apuntando al servidor. En el servidor:

```bash
git clone https://github.com/OPOSAX/music-bingo.git /opt/music-bingo
cd /opt/music-bingo
cp .env.example .env        # edita DOMAIN y ACME_EMAIL (obligatorio para este perfil)
docker compose --profile https up -d --build
```

Caddy obtiene el certificado solo. Añade `https://TU-DOMINIO/` como Redirect URI en el panel
de Spotify y listo.

### Detrás de tu propio proxy inverso

Si ya tienes nginx, Traefik o similar ocupando los puertos 80/443:

```bash
docker compose up -d --build     # publica la app en http://127.0.0.1:8080
```

y apunta tu proxy a ese puerto (`APP_PORT` en `.env` lo cambia).

### Despliegue automático desde GitHub

`.github/workflows/deploy.yml` se conecta por SSH al servidor en cada push a `main` y ejecuta
`git pull` + `docker compose up -d --build`. Para activarlo, en el repositorio ve a
**Settings → Secrets and variables → Actions** y crea:

| Tipo     | Nombre           | Valor                                                    |
| -------- | ---------------- | -------------------------------------------------------- |
| Secret   | `DEPLOY_HOST`    | IP o dominio del servidor                                |
| Secret   | `DEPLOY_USER`    | usuario SSH (con permiso para usar Docker)               |
| Secret   | `DEPLOY_SSH_KEY` | clave privada SSH dedicada al despliegue                 |
| Secret   | `DEPLOY_PATH`    | ruta del clon en el servidor, p. ej. `/opt/music-bingo`  |
| Variable | `DEPLOY_ENABLED` | `true`                                                   |
| Variable | `DEPLOY_PROFILE` | `https` si usas Caddy; vacío si usas tu propio proxy     |

Genera la clave con `ssh-keygen -t ed25519 -f deploy_key -N ""`, añade `deploy_key.pub` a
`~/.ssh/authorized_keys` del usuario en el servidor y guarda el contenido de `deploy_key`
como secreto. La CI (`.github/workflows/ci.yml`) además construye la imagen y comprueba que
responde en cada push.

### GitHub Pages (alternativa sin servidor)

Al ser un sitio estático, también se puede publicar en GitHub Pages con
`.github/workflows/pages.yml` (activa Pages con origen *GitHub Actions*).

## Estructura

```
public/           Página, estilos y (tras compilar) public/js/
src/
  main.ts         Arranque y enrutado por hash
  auth.ts         OAuth PKCE con Spotify
  spotify-api.ts  Cliente de la Web API (listas, canciones, dispositivos, play/pause)
  player.ts       Web Playback SDK y reproducción de fragmentos
  bingo.ts        Generación de tarjetas y detección de líneas/bingo (lógica pura)
  rng.ts          Aleatoriedad determinista
  share.ts        Codificación de tarjetas en enlaces
  qr.ts           Generador de códigos QR (sin dependencias)
  store.ts        Persistencia en localStorage
  views/          Pantallas: inicio, configuración, anfitrión, tarjetas, jugador
tests/            Pruebas con node:test
serve.mjs         Servidor estático de desarrollo
Dockerfile        Imagen de producción (compila + nginx)
docker-compose.yml Perfiles: por defecto (app), https (Caddy), dev
docker/           nginx.conf y Caddyfile
```

## Limitaciones conocidas

- Spotify exige Premium para el Web Playback SDK y para controlar la reproducción por API.
- Las listas editoriales de Spotify (las que crea el propio Spotify) no están disponibles
  para apps en modo desarrollo; usa listas propias o de otros usuarios.
- Los enlaces de tarjeta contienen las canciones, no se sincronizan con el anfitrión:
  la comprobación oficial siempre la hace el anfitrión con el número de tarjeta.
- El QR contiene la tarjeta completa, así que con tarjetas 5×5 y títulos largos puede ser
  denso; muéstralo grande en pantalla (la vista de reparto ya lo hace) o imprímelo a 3 cm o más.
