# Origen de esta carpeta

Código reutilizado de **Biznet Talk (B-Talk)**, `https://github.com/Biznet-IT/Biznet_Talk` (carpeta `B-Talk/`,
commit `d16a6e1`), fork de MiroTalk SFU bajo licencia AGPL-3.0 (ver `LICENSE`).

| Fichero | Origen | Cambios |
| --- | --- | --- |
| `Logger.js` | `app/src/Logger.js` | ninguno |
| `Peer.js` | `app/src/Peer.js` | `createProducer()` acepta `options { appData, paused }` para crear el producer del micrófono del público **en pausa** y con su `appData` |
| `Room.js` | `app/src/Room.js` | `produce()` acepta `options { appData, paused, announce }`; con `announce:false` **no** emite `newProducers` a los demás peers (consumo selectivo) |
| `config.js` | `app/src/config.template.js` | recortado a `console` y `mediasoup` (workers, router, transports) con autodetección de IP y `BTALK_ANNOUNCED_IP` |

El resto de B-Talk (UI de videollamada, API REST, OIDC, webhooks, Sentry, ChatGPT, grabación) no se
necesita para el modo concierto y no se copia. Las variantes `mirotalksfu-*` del repositorio no se usan.
