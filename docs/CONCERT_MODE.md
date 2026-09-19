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

## 2. Integración con Biznet_Talk (qué se reutiliza y qué hay que tocar)

Este repositorio contiene **todo el módulo Concert** listo para engancharse a B-Talk; no crea otro
SFU ni usa LiveKit ni P2P. El servidor real (mediasoup Router, WebRtcTransports, producers,
consumers, autenticación) sigue siendo el de B-Talk.

> **Nota de esta entrega.** El repositorio `Biznet-IT/Biznet_Talk` no era accesible desde esta
> sesión (repositorio privado de otra organización), así que la integración del lado servidor se
> entrega como módulo portable + checklist. Para pegarlo dentro de B-Talk hay que abrir una sesión
> con ese repositorio.

### Ficheros portables al servidor B-Talk

| Fichero | Uso en B-Talk |
| --- | --- |
| `src/concert/protocol.ts` | Tipos, eventos, `readConfig(process.env)` |
| `src/concert/concert-room.ts` | Una instancia por sala: `new ConcertRoom(roomId, config, media, emitter)` |
| `src/concert/server-handlers.ts` | `attachConcertHandlers(room, socket, role)` en el `io.on('connection')` de B-Talk y `assertCanConsume(room, role, producer.appData)` en el handler `consume` |

`MediaControl` se implementa con el mediasoup del servidor:

```js
const media = {
  pauseProducer: (id) => producers.get(id)?.pause(),
  resumeProducer: (id) => producers.get(id)?.resume(),
  closeProducer: (id) => { producers.get(id)?.close(); producers.delete(id); },
};
const emitter = {
  toParticipant: (participantId, event, payload) => io.to(socketOf(participantId)).emit(event, payload),
  toOperators: (event, payload) => io.to(`${roomId}:operators`).emit(event, payload),
};
```

### Checklist en el servidor B-Talk

1. **Rol desde el servidor.** `attachConcertHandlers(room, socket, role)` recibe el rol resuelto por
   la sesión/token de B-Talk. **Nunca** se lee `role` del payload del cliente (los tests lo cubren).
2. **Handler `produce`.** Cuando `appData.source === 'crowd-mic'`:
   - crear el producer con `paused: true`;
   - llamar a `room.registerProducer(participantId, producer.id, appData)`; si devuelve `false`,
     cerrar el producer (appData inválido, participante no está en PREPARING, o duplicado).
3. **Handler `consume`.** Antes de crear el consumer: `assertCanConsume(room, socket.role, producer.appData)`.
   Además, **no anunciar** producers `crowd-mic` a los demás participantes (`newProducer` broadcast).
4. **`CONCERT_MODE=false`** ⇒ `concert:join` responde `{ok:false, code:'disabled'}` y nada más se registra.
5. **RECV transport solo para operadores.** El teléfono nunca crea RECV transport ni consume.
6. **Cliente mediasoup.** El navegador carga `mediasoup-client` desde
   `${BTALK_URL}/concert/mediasoup-client.js` (build ESM). Servirlo desde B-Talk (o cambiar la ruta
   en `src/concert/session.ts`).
7. **Servir `socket.io.esm.min.js`** (Socket.IO ya lo hace en `/socket.io/socket.io.esm.min.js`).
8. **`getAudioConstraints()` en B-Talk (bug a verificar).** El informe de partida menciona una
   **asignación cruzada** en esa función (p. ej. `noiseSuppression` recibiendo el valor de
   `echoCancellation` o viceversa). Este módulo **no** usa esa función: los perfiles están en
   `micConstraints()` (`src/concert/media-service.ts`). Al integrar, comprobar `getAudioConstraints()`
   con un test que compare las claves de entrada y salida una a una antes de tocarla; no cambiar el
   comportamiento de las videollamadas normales de B-Talk.
9. **DRM.** Nada de este módulo captura ni intercepta el audio protegido de Spotify. La referencia
   `SPOTIFY` es solo `METADATA_ONLY`.

---

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

### Con B-Talk

1. Variables en el servidor B-Talk (`.env`):

   ```
   CONCERT_MODE=true
   MAX_LIVE_MICS=2
   MAX_PREPARED_MICS=2
   CONCERT_AUDIO_PROFILE=SING
   CONCERT_NOISE_REDUCTION=LIGHT
   AEC_ENABLED=true
   REFERENCE_AUDIO_MODE=MIXER
   ```
2. En `#/dj` indicar `BTALK_URL` (p. ej. `https://talk.ejemplo.com`) y la sala. El panel guarda la
   configuración en localStorage; nada de dominios ni secretos en el código.
3. El QR del panel abre `#/sing?room=<sala>&btalk=<url>` en los móviles.

### Tests, lint y build

```bash
npm run build     # tsc estricto (lint de tipos)
npm test          # 73 tests: bingo + concert (estado, DSP, medios, flujo completo, métricas)
node --expose-gc scripts/concert-load-test/index.mjs --sim --ready 100,1000,5000
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
- La integración final con los handlers `produce/consume` de B-Talk queda pendiente de una sesión con
  acceso a ese repositorio (ver checklist).

## 9. Siguientes pasos

1. Sesión con `Biznet-IT/Biznet_Talk`: pegar `concert-room` + `server-handlers`, `paused: true` en
   `produce`, `assertCanConsume` en `consume`, servir `mediasoup-client` ESM, verificar
   `getAudioConstraints()`.
2. Prueba real con mixer + interfaz USB y grabación A/B para ajustar `taps`/`mu` del NLMS.
3. Evaluar AEC3 (WASM) si la sala exige más de 25 dB de rechazo.
4. Rol `audio-engine` como servicio headless (Node + mediasoup consumer) para no depender del
   navegador del DJ.
