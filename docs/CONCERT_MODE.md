# BIZNET CROWD MIC · Concert Mode

Modo concierto para eventos con público: cualquier persona abre una web en su móvil, pulsa
**ESTOY DISPONIBLE** y el DJ decide, desde su panel, quién canta o habla por el PA. Diseñado para
salas de **100 a 5000 personas en READY** con solo **1–2 micrófonos activos** a la vez.

Este documento describe la arquitectura, la integración con **Biznet_Talk (B-Talk)**, el cableado
físico, el cancelador de eco por referencia y cómo probarlo.

---

## 1. Arquitectura

```
 Teléfonos (participantes)                      Servidor B-Talk (Node + mediasoup)                 DJ
 ┌───────────────────────┐   Socket.IO          ┌───────────────────────────────────┐   Socket.IO  ┌─────────────────────────┐
 │ /sing                 │ ───────────────────▶ │ concert:* handlers                │ ◀──────────▶ │ /dj                     │
 │ ParticipantClient     │  join / ready / …    │ ConcertRoom (estado autoritativo) │  list/metrics│ DjClient                │
 │ ConcertMediaService   │                      │ selective consume (crowd-mic)     │              │ ConcertAudioEngine      │
 │  SEND transport +     │ ═══ WebRTC (Opus) ══▶│ mediasoup Router                  │══ WebRTC ═══▶│  HPF→AEC→NS→EQ→comp→lim │
 │  1 producer (paused)  │  solo al PREPARE     │  producer paused → resume en LIVE │  consume     │  → salida USB → mixer   │
 └───────────────────────┘                      └───────────────────────────────────┘              └─────────────────────────┘
                                                                                                        ▲ MUSIC_REFERENCE
                                                                                                        │ (AUX/MATRIX del mixer
                                                                                                        │  por entrada USB)
```

**Principios**

- **El servidor manda.** `ConcertRoom` (`src/concert/concert-room.ts`) es la única máquina de estados
  válida. Los clientes solo piden y obedecen `concert:state`.
- **READY es gratis.** READY = solo Socket.IO. Sin `getUserMedia`, sin transports, sin producers.
  5000 personas en READY cuestan ~8 KB de RAM por participante en el servidor y cero en mediasoup.
- **PREPARE es barato y reversible.** Crea **solo** el SEND transport y **un** producer de audio
  **en pausa**. Nada suena todavía. CANCEL lo deshace por completo.
- **GO LIVE es instantáneo.** Reanuda el producer que ya existe (servidor y cliente). MUTE lo pausa.
- **Consumo selectivo.** Solo `dj`, `admin` y `audio-engine` pueden consumir producers con
  `appData.source === 'crowd-mic'`. Un participante jamás recibe el audio de otro.
- **Deltas, no listas.** El DJ recibe `participant-added/updated/removed` y `metrics`; la lista
  completa se pide paginada (`concert:list` con `query/offset/limit`).

### Máquina de estados

```
DISCONNECTED → CONNECTED → READY → PREPARING → PREPARED → LIVE ⇄ MUTED
                   ▲          ▲        │  ERROR            │        │
                   │          └────────┴───(READY)◀────────┴────────┘   END / CANCEL / stop-my-mic
                   └── leave
```

Las transiciones válidas están en `TRANSITIONS` (`src/concert/protocol.ts`); cualquier otra lanza
`ConcertError('invalid-transition')`.

| Estado | Quién lo provoca | Recursos |
| --- | --- | --- |
| CONNECTED | `concert:join` | socket |
| READY | `concert:ready` (participante) | socket |
| PREPARING | `concert:prepare` (DJ) → orden al teléfono | slot reservado |
| PREPARED | `concert:prepared` (teléfono, tras crear el producer) | SEND transport + producer **paused** |
| LIVE | `concert:go-live` (DJ) | producer **resumed** |
| MUTED | `concert:mute` (DJ) | producer paused |
| READY (de nuevo) | `concert:end` (DJ), `concert:stop-my-mic` (participante), fallo | todo cerrado, pistas detenidas |
| ERROR | `concert:prepare-failed` | limpieza; vuelve solo a READY |

### Límites

`MAX_LIVE_MICS` (por defecto 2) y `MAX_PREPARED_MICS` (por defecto 2) se validan **en el servidor**
antes de PREPARE / GO LIVE / UNMUTE. Los slots se llaman `MIC_A`, `MIC_B`, … (`slotIds(n)`).

### Reconexión

El `participantId` es persistente (localStorage) y viaja en `concert:join`. Si el socket cae, el
participante conserva su estado y su antigüedad en READY durante `disconnectGraceMs` (30 s). Si
estaba en un slot, el DJ recibe `concert:error{code:'participant-lost'}` y el slot se libera al
expirar la gracia.

### Eventos Socket.IO

Todos con prefijo `concert:` y acuse `{ ok, code?, message? }`:

| Cliente → servidor | Servidor → cliente |
| --- | --- |
| `join`, `ready`, `leave`, `stop-my-mic`, `heartbeat` (participante) | `state` (mi estado), `prepare` (orden con `slotId`, `profile`, `transport`), `live`, `error` |
| `prepared`, `prepare-failed` (teléfono) | `preparing`, `prepared`, `prepare-failed`, `live` (operadores) |
| `prepare`, `go-live`, `mute`, `unmute`, `end`, `list`, `metrics` (DJ/admin) | `participant-added/updated/removed`, `metrics` (operadores) |
| `rtp-capabilities`, `create-transport`, `connect-transport`, `produce`, `consume`, `resume-consumer` | envoltorios de los handlers de B-Talk |

---

## 2. Integración con Biznet_Talk: qué se reutiliza y dónde vive

La regla es que **el bingo musical incorpora las piezas de B-Talk que necesita**, no al revés. No se
crea otro SFU, no hay LiveKit ni P2P: el SFU es el mismo mediasoup de B-Talk.

### Carpeta `server/` (servicio Concert)

| Ruta | Contenido |
| --- | --- |
| `server/btalk/Room.js`, `Peer.js`, `Logger.js` | Núcleo SFU de B-Talk (`B-Talk/app/src`) copiado con dos cambios mínimos, ver `server/btalk/NOTICE.md` |
| `server/btalk/config.js` | Recorte de `config.template.js`: workers, router (solo Opus), transports, autodetección de IP y `BTALK_ANNOUNCED_IP` |
| `server/public/sfu/MediasoupClient.js` | Bundle mediasoup-client de B-Talk (`public/sfu`), servido en `/sfu/MediasoupClient.js` |
| `server/concert-server.mjs` | Express + Socket.IO + workers mediasoup (adaptado de `Server.js`) y los handlers `concert:*` de `src/concert` |
| `server/test/smoke.mjs` | Prueba de humo con socket.io-client: roles, PREPARE, transports, produce rechazado, CONCERT_MODE=false |
| `server/Dockerfile` | Imagen única: compila la app, instala mediasoup y sirve todo en el puerto 3010 |

### Cambios aplicados al código de B-Talk (documentados en `NOTICE.md`)

1. `Peer.createProducer(..., options)`: el producer del micrófono del público se crea con
   `paused: true` y con su `appData` (`source: 'crowd-mic'`, `participantId`, `roomId`, `slotId`).
2. `Room.produce(..., options)`: con `announce: false` **no** emite `newProducers` al resto de peers.
   Nadie salvo el DJ conoce el producer; el consumo lo autoriza `assertCanConsume` (solo
   `dj`/`admin`/`audio-engine`).

### Reglas que impone `concert-server.mjs`

- **Rol desde el servidor.** `socket.handshake.auth.token` se compara con `CONCERT_DJ_TOKEN` /
  `CONCERT_ADMIN_TOKEN`; cualquier otra cosa es `participant`. El cliente nunca envía su rol.
- **Participante:** solo `concert:create-transport{direction:'send'}` y solo en estado PREPARING; solo
  `kind: 'audio'`; `appData` validado contra su `participantId`, sala y slot.
- **Operador:** solo transporte `recv`; `concert:consume` pasa por `assertCanConsume`.
- **Peers de mediasoup bajo demanda.** READY no crea `Peer` ni transporte; el router de la sala no se
  cierra mientras queden participantes (a diferencia de `Room.removePeer` de B-Talk).
- `CONCERT_MODE=false` ⇒ `concert:join` responde `{ok:false, code:'disabled'}`.

### Bug verificado en B-Talk: `getAudioConstraints()` (asignación cruzada)

En `B-Talk/public/js/RoomClient.js` (líneas 1372–1373):

```js
echoCancellation: switchNoiseSuppression.checked,
noiseSuppression: switchEchoCancellation.checked,
```

Los interruptores están intercambiados. Este módulo **no** usa esa función (los perfiles están en
`micConstraints()` de `src/concert/media-service.ts`), así que el modo concierto no hereda el bug.
En el repositorio de B-Talk la corrección es intercambiar las dos claves; antes de aplicarla conviene
un test que compare cada interruptor con la restricción resultante, y no toca las videollamadas.

### DRM

Nada captura ni intercepta el audio protegido de Spotify. La referencia `SPOTIFY` es solo metadata.

## 3. Audio: cadena, referencia y AEC

### Perfiles (`CONCERT_AUDIO_PROFILE`, SING por defecto)

| | SING | TALK |
| --- | --- | --- |
| Teléfono: `echoCancellation` | on (está junto al PA) | on |
| Teléfono: `noiseSuppression` / `autoGainControl` | **off** (conserva dinámica y armónicos) | on |
| Opus | 64 kb/s, FEC, **sin DTX** | 32 kb/s, FEC, DTX |
| DJ: HPF | 80 Hz | 120 Hz |
| DJ: EQ (graves/medios/agudos) | −1.5 / +1 / +2.5 dB | −4 / +3 / +1 dB |
| DJ: compresor | −20 dB, 3:1 | −18 dB, 4:1 |

### Cadena en el DJ (`ConcertAudioEngine`)

`consumer WebRTC → HPF → AEC por referencia (AudioWorklet) → compuerta/NS → EQ 3 bandas → compresor → limitador → ganancia → master → limitador → salida`

Cada etapa es un `AudioProcessor` con bypass (`src/concert/audio/processors.ts`). El **modo técnico**
del panel (`RAW`, `AEC ONLY`, `AEC + NS`, `FINAL`) desactiva etapas para comparar A/B.

### MUSIC_REFERENCE (`REFERENCE_AUDIO_MODE`)

| Modo | Fuente | Audio real |
| --- | --- | --- |
| `MIXER` (recomendado) | Entrada de una interfaz USB con el AUX/MATRIX del mixer | sí |
| `INTERNAL` | `<audio>` del navegador (archivo de prueba) | sí |
| `SPOTIFY` | Web Playback SDK → solo canción/posición (`METADATA_ONLY`) | **no** (DRM) |
| `NONE` | — | no |

### Cancelador de eco por referencia (`ReferenceEchoCanceller`)

El micrófono del teléfono capta voz **+ música del PA**. El AEC del navegador del teléfono no la
elimina (esa música no sale del altavoz del móvil). Por eso el DJ cancela con la **referencia
eléctrica** del mixer:

1. **`ReferenceDelayEstimator`**: correlación cruzada mic↔referencia en ventanas de 400 ms, busca
   el retardo en **0–1000 ms** (`estimateDelay`, `src/concert/audio/dsp.ts`) y se bloquea cuando la
   correlación es estable. También admite retardo manual desde el panel.
2. **`NlmsCanceller`** de **dos filtros** (512 taps): un filtro de fondo adapta siempre y se copia al
   de primer plano solo cuando reduce mejor el eco; **detección de doble voz** (residual ≫ predicción)
   congela la adaptación mientras la persona canta para no "comerse" la voz.
3. Métricas: retardo, correlación, **ERLE**, reducción total, doble voz.

**Elección**: NLMS propio (sin dependencias, en AudioWorklet, ~1 ms de CPU por canal). Con la
referencia bien alineada obtiene 15–25 dB de ERLE en los tests sintéticos
(`tests/concert-dsp.test.ts`). Alternativas evaluables más adelante: AEC3 de WebRTC compilado a WASM
o Speex/RNNoise para NS, si el nivel de música en la sala exige >25 dB.

### Reducción de ruido (`CONCERT_NOISE_REDUCTION`)

`OFF | LIGHT | MEDIUM | STRONG` → expansor descendente en el worklet (fuerza 0 / 0.3 / 0.6 / 0.9 y
umbral creciente). En SING se recomienda LIGHT.

### Salida (`AudioOutputProvider`)

`BrowserOutputProvider` usa `AudioContext.setSinkId` para enviar la mezcla a la interfaz USB
(Output 1/2 → canal del mixer). En Firefox/Safari sin `setSinkId` se usa la salida por defecto del
sistema.

---

## 4. Cableado físico recomendado

```
Mixer ──AUX/MATRIX (post-fader, sin el retorno de los mics)──▶ Interfaz USB IN 1   ┐
                                                                                  ├─ Portátil del DJ (navegador /dj)
Interfaz USB OUT 1/2 ◀──────────────────────────────────────────── mezcla CROWD MIC ┘
        │
        └──▶ Canal libre del mixer ("CROWD MIC") → PA
```

1. **Referencia**: envía al `IN 1` de la interfaz **la música** (Spotify/DJ) **sin** el canal CROWD
   MIC, para que el cancelador no se realimente. Un AUX post-fader o una MATRIX es lo ideal.
2. **Retorno**: `OUT 1/2` de la interfaz a un canal del mixer con HPF y el fader inicialmente bajo.
3. En el panel del DJ: *Motor de audio → Entrada USB = la interfaz, Canal L, Salida = la interfaz*.
4. Wi-Fi del público: SSID dedicado, 5 GHz, con limitación de clientes por AP; 5000 sockets
   inactivos consumen ~1–2 kb/s cada uno solo por heartbeat.

---

## 5. Puesta en marcha

### Modo demo (sin servidor)

```bash
npm run build && npm start        # http://127.0.0.1:8888
```

- `#/dj` → *Abrir panel* (BTALK_URL vacío) → *Simular 5 teléfonos* → PREPARE → GO LIVE → MUTE → END.
- *Iniciar motor* crea el AudioContext; los teléfonos simulados suenan como tonos con vibrato para
  ver medidores y probar la grabación A/B (`rawMic`, `musicReference`, `postAEC`, `finalOutput`).
- `#/sing` en la **misma pestaña** se conecta al mismo hub de demo.

### Con el servidor Concert (WebRTC real)

```bash
# Docker (recomendado en el servidor OVH): app + señalización + SFU en http://IP:3010/
BTALK_ANNOUNCED_IP=158.69.117.161 CONCERT_DJ_TOKEN=un-secreto docker compose --profile concert up -d --build

# Sin Docker (Node 20+, compila mediasoup en la primera instalación)
npm ci && npm run build
cd server && npm install && CONCERT_DJ_TOKEN=un-secreto node concert-server.mjs
```

1. Abre `http://IP:3010/#/dj`. El panel detecta que el origen es un servidor Concert y rellena
   `BTALK_URL`; escribe el token del DJ y abre el panel.
2. El QR del panel lleva al público a `#/sing?room=<sala>&btalk=<url>`. Los móviles necesitan
   **HTTPS** para el micrófono: en producción pon Caddy/nginx delante con WebSocket
   (`/socket.io/`) y deja abiertos los puertos UDP/TCP `40000-40100` de mediasoup.
3. Variables del servidor (`.env`):

   ```
   CONCERT_MODE=true
   MAX_LIVE_MICS=2
   MAX_PREPARED_MICS=2
   CONCERT_AUDIO_PROFILE=SING
   CONCERT_NOISE_REDUCTION=LIGHT
   AEC_ENABLED=true
   REFERENCE_AUDIO_MODE=MIXER
   CONCERT_DJ_TOKEN=...      # secreto del panel del DJ (si falta se genera uno por arranque y sale en el log)
   BTALK_ANNOUNCED_IP=...    # IP pública o LAN que anuncia mediasoup
   ```

### Tests, lint y build

```bash
npm run build     # tsc estricto (lint de tipos)
npm test          # 73 tests: bingo + concert (estado, DSP, medios, flujo completo, métricas)
node --expose-gc scripts/concert-load-test/index.mjs --sim --ready 100,1000,5000
cd server && npm install && npm test   # prueba de humo del servidor real (mediasoup + Socket.IO)
```

Tests obligatorios cubiertos:

| Requisito | Test |
| --- | --- |
| READY no llama a getUserMedia ni crea producers | `concert-media` / `concert-flow` |
| PREPARE crea un único producer en pausa | `concert-media`, `concert-room` |
| GO LIVE reanuda el producer correcto | `concert-flow` |
| MAX_LIVE_MICS / MAX_PREPARED_MICS | `concert-room`, `concert-flow` |
| END cierra producer y detiene pistas | `concert-media`, `concert-flow` |
| Solo dj/admin/audio-engine consumen crowd-mic | `concert-room` |
| El rol lo fija el servidor | `concert-flow` |
| Reconexión conserva participantId y antigüedad | `concert-flow` |
| AEC: retardo estimado, ERLE con música sola y con voz+música | `concert-dsp` |

---

## 6. Resultados de la prueba de carga (simulación en proceso, Node 22)

| READY | Alta + READY | Mensajes por ciclo PREPARE→LIVE→END | Latencia ciclo p50 / p95 | RAM servidor |
| --- | --- | --- | --- | --- |
| 100 | 8 ms | 13 | 3.5 / 4.1 ms | ~96 KB/part. (con base) |
| 1000 | 52 ms | 13 | 3.8 / 4.2 ms | 13.5 KB/part. |
| 5000 | 1.1 s | 13 | 5.3 / 6.1 ms | 7.9 KB/part. |

El número de mensajes por ciclo **no crece con N** (solo operadores reciben deltas), que era el
objetivo del diseño. Con sockets reales (`--socket`) añade el coste de Socket.IO (~50–100 KB por
conexión websocket ociosa en Node).

## 7. Latencia esperada (boca → PA)

| Tramo | ms |
| --- | --- |
| Captura + Opus en el móvil (20 ms frames) | 30–50 |
| Red Wi-Fi + mediasoup | 20–60 |
| Jitter buffer del navegador del DJ | 40–80 |
| Motor Web Audio (128 muestras, worklet) | 3–10 |
| Interfaz USB + mixer | 5–10 |
| **Total** | **~100–200 ms** |

Es aceptable para "hablar" y para cantar **sin monitor** (la persona se oye por el PA con ese
retardo; se recomienda no darle retorno en el móvil).

## 8. Limitaciones conocidas

- Sin la referencia del mixer (`NONE`/`SPOTIFY`) el AEC no puede actuar: solo HPF/NS/dinámica.
- El NLMS no cancela reverberación larga de la sala (>1 s) ni no linealidades del PA.
- `setSinkId` en `AudioContext` requiere Chrome/Edge 110+.
- iOS Safari: el AudioWorklet funciona, pero el teléfono del participante debe mantener la pestaña
  en primer plano mientras está LIVE (Wake Lock se solicita si está disponible).
- El servidor Concert necesita HTTPS delante (proxy) para que los móviles concedan el micrófono, y los
  puertos `40000-40100` abiertos; en el sandbox de desarrollo no se pudo instalar mediasoup (sin
  acceso a npm), así que la prueba de humo del servidor se ejecuta en la CI de GitHub.

## 9. Siguientes pasos

1. Desplegar el perfil `concert` en OVH detrás de Caddy con HTTPS y abrir `40000-40100/udp`.
2. Prueba real con mixer + interfaz USB y grabación A/B para ajustar `taps`/`mu` del NLMS.
3. Evaluar AEC3 (WASM) si la sala exige más de 25 dB de rechazo.
4. Rol `audio-engine` como servicio headless (Node + consumer mediasoup) para no depender del
   navegador del DJ.
5. Corregir en el repositorio de B-Talk el cruce de `getAudioConstraints()` (no afecta a este módulo).
