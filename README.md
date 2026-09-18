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
- **Reparto sin servidor**: cada tarjeta tiene un enlace autocontenido (comprimido) que se
  puede copiar, compartir con la hoja nativa del móvil o imprimir.
- **Vista de jugador**: toca para marcar, detección automática de línea y bingo, marcas
  guardadas en el dispositivo.
- **Pantalla del anfitrión**: canción oculta hasta que la reveles, historial, contador,
  tarjetas con línea/bingo en tiempo real, deshacer y reanudar la partida tras recargar.
- Interfaz en español, diseño responsive y hoja de estilos de impresión.

## Requisitos

- Cuenta **Spotify Premium** para el anfitrión (los jugadores no necesitan nada).
- Node.js 18 o superior (solo para compilar y servir en desarrollo).
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

### 2. Compila y arranca

```bash
npm install
npm run dev
```

Abre <http://127.0.0.1:8888/>, pega el Client ID y pulsa **Conectar con Spotify**.

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
2. **Reparte las tarjetas** desde la pantalla *Tarjetas*: imprímelas o envía a cada persona
   el enlace de su tarjeta (botón *Copiar enlace* o *Compartir…*). Cada tarjeta tiene un
   código `PARTIDA-Nº`.
3. En la pantalla del anfitrión pulsa **Usar este navegador** (o elige otro dispositivo de
   Spotify) y luego **Empezar**. Cada pulsación de **Siguiente canción** reproduce un
   fragmento y se para sola. Puedes **repetir** el fragmento y **revelar** el título cuando quieras.
4. Los jugadores tocan en su tarjeta las canciones que reconocen. Cuando alguien canta
   línea o bingo, escribe su número de tarjeta en **Comprobar una tarjeta** y la app te
   dice si es válida según las canciones que han sonado de verdad.

## Despliegue

Es un sitio estático: sube el contenido de `public/` (tras `npm run build`) a cualquier
hosting con HTTPS y registra esa URL como Redirect URI en el panel de Spotify.
El repositorio incluye un workflow de **GitHub Pages** (`.github/workflows/pages.yml`)
que publica automáticamente al hacer push a `main` (activa Pages con origen *GitHub Actions*).

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
  store.ts        Persistencia en localStorage
  views/          Pantallas: inicio, configuración, anfitrión, tarjetas, jugador
tests/            Pruebas con node:test
serve.mjs         Servidor estático de desarrollo
```

## Limitaciones conocidas

- Spotify exige Premium para el Web Playback SDK y para controlar la reproducción por API.
- Las listas editoriales de Spotify (las que crea el propio Spotify) no están disponibles
  para apps en modo desarrollo; usa listas propias o de otros usuarios.
- Los enlaces de tarjeta contienen las canciones, no se sincronizan con el anfitrión:
  la comprobación oficial siempre la hace el anfitrión con el número de tarjeta.
