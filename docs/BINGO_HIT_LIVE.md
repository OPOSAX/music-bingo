# Bingo Hit Live

Modalidad en la que un **animador** transmite cámara, micrófono y audio del evento y **cientos o miles de
jugadores** lo ven desde el móvil, con su cartón de Bingo Hit debajo, en la misma pantalla.

## 1. Auditoría: arquitectura sobre la que se construye

| Capa | Qué había | Cómo se reutiliza |
| --- | --- | --- |
| Frontend | App estática TypeScript (sin framework), router por hash, vistas `home/setup/host/cards/deal/join/card/sing/dj` | Se añaden las vistas `live` (animador) y `play` (entrada corta) y el componente `LiveHostVideo` dentro de la tarjeta del jugador |
| Plano de juego | ntfy.sh: el anfitrión publica `SyncState`, `pool` y recibe `claim`; los jugadores se suscriben por SSE | **Mismos mensajes**, ahora transportados también por Socket.IO (`game:*`) cuando la partida tiene servidor Live; ntfy sigue funcionando sin servidor |
| Backend | `server/concert-server.mjs`: Express + Socket.IO + **mediasoup de Biznet Talk** (`server/btalk`), roles por token | Se añade `server/live.mjs` con los handlers `live:*` y `game:*`; comparte sala, peer y transportes con el módulo Karaoke |
| WebRTC | mediasoup (SFU) + bundle `mediasoup-client` de B-Talk; adaptadores `BTalkMediaAdapter` / `BTalkConsumerAdapter` | 1 publisher → N viewers sobre el mismo SFU; sin P2P, sin LiveKit, sin iframe |
| Autenticación | Spotify PKCE (anfitrión); token de operador en el servidor (`CONCERT_DJ_TOKEN`) | `LIVE_HOST_TOKEN` (o el del DJ) da el rol `host` **en el servidor**; el cliente nunca envía su rol |
| Base de datos | Ninguna (localStorage) | El servidor guarda en memoria el histórico del plano de juego por sala (cfg, pool, último estado) |
| TURN | No existía | Configurable por variables (`TURN_*`), con credenciales temporales HMAC si hay `TURN_SECRET` |

## 2. Arquitectura final

```
                ANIMADOR (/live)                         ANFITRIÓN DE LA PARTIDA (/host)
                cámara + mic/mixer USB                   Spotify · canciones · estado
                        │                                          │
                 WebRTC (mediasoup)                 Socket.IO game:publish (+ ntfy)
                        │                                          │
                        ▼                                          ▼
              ┌──────────────────── servidor Concert/Live (server/) ────────────────────┐
              │  SFU mediasoup (B-Talk)          │  ConcertRoom / Live state por sala   │
              │  producers live-host (vídeo+audio)│  historial cfg/pool/state, bingos,   │
              │  1 → N consumers                  │  reacciones agregadas, métricas      │
              └──────────────┬────────────────────┴───────────────┬──────────────────────┘
                  WebRTC (recv only)                       Socket.IO game:message / live:*
                     ▼   ▼   ▼                                   ▼   ▼   ▼
                 Jugador Jugador Jugador   (/play?e=EVENTO → tarjeta con LiveHostVideo)
                 vídeo   audio   cartón · BINGO · reacciones · estado 🟢🟡🔴
```

- **MEDIA PLANE**: `live:rtp-capabilities`, `live:create-transport` (host solo `send`, viewer solo `recv`),
  `live:connect-transport`, `live:produce` (solo host, `appData.source = 'live-host'`), `live:consume`
  (solo producers `live-host`), `live:start/stop`, `live:producer_added/state`.
- **GAME PLANE**: `game:publish` (solo host: `cfg`, `pool`, `SyncState`), `game:claim` (jugador → hosts),
  `game:message` (servidor → clientes, con histórico al unirse), `live:bingo` → `live:bingo_claimed`
  (validado en el servidor regenerando la tarjeta), `live:winner` → `live:winner_announced`,
  `live:reaction` → `live:reactions` (agregadas cada 400 ms), `live:players_count`,
  `live:host_online/offline`, `live:metrics` / `live:stats`.
- Mapa con los eventos pedidos: `join_event` = `live:join`; `song_started/paused/resumed/finished` =
  campos `cur`/`play`/`now` del `SyncState` existente (no se duplican eventos); `player_marked_song` se
  mantiene local (autoMark + marcas en el móvil, como ya hacía Bingo Hit); `bingo_claimed` =
  `live:bingo_claimed`; `winner_announced` = `live:winner_announced`; `players_count` = `live:players_count`.
- **Sala automática**: `liveRoomId(eventId) = bingo-<eventId>`; el evento es el código de partida.
- **El vídeo nunca sincroniza el juego**: la latencia del vídeo no afecta al estado.

## 3. Archivos

Creados: `src/live/protocol.ts`, `session.ts`, `game-channel.ts`, `viewer.ts`, `publisher.ts`,
`views/live-video.ts`, `views/live-host.ts`, `views/host-panel.ts`, `views/play.ts`, `server/live.mjs`,
`server/test/unit.mjs`, `tests/live-protocol.test.ts`, este documento.

Modificados: `src/sync.ts` (publicar/suscribir también por Socket.IO), `src/store.ts` (`liveServer`),
`src/share.ts` (`l` en tarjeta y enlace), `src/views/card.ts` (vídeo, botón BINGO, ganador),
`src/views/join.ts` (`renderJoinPayload`, enlace Live), `src/views/deal.ts` (enlace corto `/play`),
`src/views/host.ts` (panel Live, cfg, bingos), `src/main.ts` (rutas `/live` y `/play`),
`src/concert/session.ts`, `media-service.ts`, `consumer.ts` (ICE servers, `paused:false`, `replaceTrack`),
`server/concert-server.mjs` (`live.mjs`, `/live/config`, `LIVE_HOST_TOKEN`), `server/test/smoke.mjs`,
`public/styles.css`, `.env.example`, `docker-compose.yml`, `README.md`.

## 4. Variables de entorno (servidor)

| Variable | Uso |
| --- | --- |
| `LIVE_HOST_TOKEN` | Token del animador (panel `/live`). Si falta se usa `CONCERT_DJ_TOKEN`; si ninguno, se genera uno por arranque y sale en el log |
| `STUN_SERVER_URL` | STUN entregado a los clientes |
| `TURN_SERVER_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | TURN estático (NAT/CGNAT/redes corporativas) |
| `TURN_SECRET` | Si se define, credenciales TURN **temporales** (HMAC-SHA1, coturn `use-auth-secret`) |
| `BTALK_ANNOUNCED_IP`, `RTC_MIN_PORT`, `RTC_MAX_PORT`, `MEDIASOUP_WORKERS` | mediasoup (ver `docs/CONCERT_MODE.md`) |
| `LIVE_MAX_VIEWERS` | Orientativo para el panel |
| `PORT`, `STATIC_DIR`, `CORS_ORIGIN` | HTTP |

El cliente no tiene variables: descubre el servidor (`/health` con `concert:true`) cuando la app se sirve
desde él, o lo recibe en el enlace (`#/play?e=…&l=…`). Los ICE servers llegan en el acuse de `live:join`.
Ningún secreto va en el frontend (el token del animador se guarda en `sessionStorage`).

## 5. Levantar el entorno local

```bash
npm ci && npm run build
cd server && npm install            # mediasoup (necesita red la primera vez)
LIVE_HOST_TOKEN=animador node concert-server.mjs     # http://127.0.0.1:3010/
```

O con Docker: `LIVE_HOST_TOKEN=animador BTALK_ANNOUNCED_IP=<IP LAN> docker compose --profile concert up -d --build`.

## 6. Procedimiento de prueba HOST + PLAYER

1. **Anfitrión** (portátil): `http://IP:3010/#/` → conectar Spotify → crear partida → en la pantalla del
   anfitrión, panel **🔴 Bingo Hit Live**: el servidor se rellena solo; escribe el token → *Activar Live*.
2. **Animador** (mismo portátil u otro con cámara): *Abrir panel del animador* (`#/live?event=<código>`):
   elegir cámara y la entrada de audio del mixer (USB), comprobar el medidor, *Iniciar transmisión*.
   El estado pasa a 🔴 EN VIVO y "Servidor WebRTC: publicando".
3. **Jugador** (móvil, misma red o pública con TURN): escanear el QR de *Repartir con QR*
   (`#/play?e=…`), escribir el nombre → recibe su tarjeta con el vídeo encima. Un toque en
   **🔊 Entrar a Bingo Hit** habilita el audio. Marcar canciones, tocar reacciones, y cuando complete
   línea/tarjeta pulsar **¡BINGO!**.
4. **Anfitrión/animador**: aparece "Ana canta bingo (🟢 válido)" con la validación del servidor →
   *Anunciar ganador* → todos ven 🎉 BINGO 🎉 con el nombre.
5. Apagar el Wi-Fi del móvil 10 s: el jugador ve 🟡 RECONECTANDO, conserva marcas, y al volver
   recupera vídeo y estado (rejoin + rebuild del transporte recv).

Pruebas automáticas: `npm test` (unidad), `cd server && npm test` (unidad + humo con mediasoup real:
roles, transportes, publish/consume, histórico, bingo validado, ganador, reacciones y límites).

## 7. Escalabilidad y cuellos de botella

- **SFU, no mesh**: cada jugador consume 2 tracks del router; el animador publica una sola vez.
- Ancho de banda de salida ≈ 1,3 Mb/s por espectador en 720p (`maxVideoKbps` 1200 + audio 96 kb/s):
  500 espectadores ≈ 650 Mb/s, 1000 ≈ 1,3 Gb/s. Para 1 000+ conviene bajar a 480p/600 kb/s (opción
  `maxVideoKbps` del publicador) o desplegar varios workers/servidores con *pipeTransports* de mediasoup.
- Un router mediasoup por sala; los workers se reparten por sala (`MEDIASOUP_WORKERS`). Para varias
  salas grandes: varios servidores detrás del mismo dominio o un balanceador por sala.
- Socket.IO: 5000 sockets ociosos ≈ 250–500 MB en Node; los deltas del juego son pequeños y se emiten
  una vez por cambio; las reacciones se agregan por ventana de 400 ms y se limitan por socket.
- TURN: en redes móviles/corporativas un 10–20 % de clientes lo necesitan; coturn con `TURN_SECRET`.

## 8. Limitaciones para producción

- Se necesita **HTTPS** delante (Caddy/nginx con WebSocket) para cámara/micrófono y autoplay.
- Sin TURN configurado, los jugadores tras CGNAT/firewalls no recibirán vídeo.
- El histórico del plano de juego vive en memoria: reiniciar el servidor obliga al anfitrión a
  "Reenviar la lista de canciones" (ya existe ese botón).
- El animador publica desde un navegador; para 1 000+ espectadores conviene una salida SFU→SFU
  o un servidor con salida ≥ 2 Gb/s.
- La validación de bingo usa el último `SyncState` publicado: si el anfitrión está desconectado,
  el servidor devuelve "sin comprobar" y el anfitrión valida a mano.
- Invitar al ganador a cámara (bidireccional) queda preparado (el viewer ya tiene sesión y el SFU
  admite `send` para roles autorizados) pero no implementado.
