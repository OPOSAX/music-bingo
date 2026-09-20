# Plataforma Bingo Hit: roles, eventos, tarjetas y pagos

Especificación incorporada: modalidades **LOCAL / ONLINE / HYBRID**, tarjetas **FREE / PAID** (independientes de la
modalidad), Administrador General, animadores con permisos y **pagos centralizados en Bingo Hit**.

## 1. Auditoría previa

| Área | Encontrado | Decisión |
| --- | --- | --- |
| Frontend | App estática TypeScript sin framework, router por hash | Nuevas rutas `/event`, `/pay`, `/play`, `/events`, `/admin`; mismo `h()` y estilos |
| Backend | `server/`: Express + Socket.IO + mediasoup (B-Talk) | Se añade `server/platform/*` sin dependencias nuevas; API montada antes del estático |
| Base de datos | Ninguna | `server/platform/store.mjs`: fichero JSON con escritura atómica y migraciones por versión (`MIGRATIONS`) |
| Roles | Token de DJ/animador en el servidor; jugador anónimo | `PLATFORM_ADMIN` (token), `HOST` (token por animador con permisos), `PLAYER` (token estable por dispositivo) |
| Eventos | `GameState` en el navegador del anfitrión | Entidad `Event` en el servidor; la partida de Spotify se vincula al evento (`PUT /api/host/events/:id/game`) |
| Cartones | `generateCard(seed, index)` determinista | El servidor asigna índices y regenera tarjetas para validar bingos; el cliente las pinta |
| WebSocket | Socket.IO (`game:*`, `live:*`) | Acceso a la sala validado con `canPlayerJoinEvent` |
| WebRTC | mediasoup + mediasoup-client de B-Talk | Sin cambios: ONLINE/HYBRID usan la transmisión Live existente |
| Pagos | Ninguno | `PaymentService` con proveedores mock / Transbank / Mercado Pago |

## 2. Modelo (entidades nuevas)

- **User** (`users`): `id, role (HOST), name, email, status (ACTIVE|SUSPENDED), permissions {canCreateLocalEvents, canCreateOnlineEvents, canCreateHybridEvents, canCreateFreeEvents, canCreatePaidEvents, canSetCardPrice, canStartLive, maxEventCapacity}, tokenHash`.
- **Event** (`events`): `id, hostId, name, description, startsAt, coverUrl, prizes, rules, eventMode (LOCAL|ONLINE|HYBRID), cardDistribution (FREE|PAID), localCardDistribution, remoteCardDistribution, capacity, free {maxCardsPerPlayer, totalCardLimit, opensAt, closesAt, allowGuests, allowPromoCodes}, paid {pricePerCard, currency, maxCardsPerPlayer, totalCardLimit, salesStartAt, salesEndAt}, game {seed, gridSize, freeCenter, cardCount, playlistName, topic, tracks}, status (DRAFT|PUBLISHED|LIVE|FINISHED|SUSPENDED), liveRoomId = bingo-<id>`.
- **Player** (`players`): `id, name, contact, status, tokenHash`.
- **Card** (`cards`): `id, eventId, playerId, index, acquisitionType (PURCHASE|FREE|COMPLIMENTARY|PROMO|LOCAL), orderId?, promoCode?, revoked?`.
- **Order** (`orders`): `id, eventId, playerId, quantity, unitPrice, subtotal, discount, total, currency, status (PENDING|PAID|FAILED|CANCELLED|REFUNDED), createdAt, paidAt`.
- **Payment** (`payments`): `id, orderId, provider, providerTransactionId, amount, currency, status, createdAt, confirmedAt, webhookIds[]` (sin datos del instrumento de pago).
- **EventAccess** (`eventAccess`): `id, eventId, playerId, via, grantedAt`.
- **Promotion** (`promotions`): `code, eventId|null, type (FREE_CARDS|DISCOUNT_PCT), value, maxUses, uses, active`.
- **WebhookLog** (`webhookLog`): idempotencia por `providerEventId`. **Audit**: acciones administrativas.
- **Settings**: `payments {provider, providers {transbank, mercadopago}}, pricing {hostCanSetPrice, minimumCardPrice, maximumCardPrice, fixedCardPrice, defaultCurrency}, limits {maxEventCapacity, maxCardsPerPlayer}, commission {platformFeePct}`.

Migraciones: `schemaVersion` en el fichero; `MIGRATIONS[n]` lleva de `n` a `n+1` al arrancar. Versión actual: 1.

## 3. Principios implementados

- `eventMode` y `cardDistribution` son propiedades independientes (no existen enums combinados).
- `liveStreamingEnabled = eventMode !== 'LOCAL'`; `checkoutRequired = cardDistribution === 'PAID'`.
- HYBRID guarda `localCardDistribution` y `remoteCardDistribution` para políticas distintas (por defecto la general).
- Una `Card` válida puede existir sin `Payment` (FREE, PROMO, COMPLIMENTARY, LOCAL).
- Los pagos los crea y confirma **solo el backend** vía proveedor + webhook firmado; llegar a la URL de éxito no marca nada.
- `grossSales` = órdenes PAID confirmadas; `platformRevenue` = comisión configurada; `hostSettlement` es conceptual (no hay liquidación automática).
- Toda autorización es server-side: rol por token, permisos del animador, propiedad del evento, acceso `canPlayerJoinEvent`, publicación WebRTC (`canStartLive`) y controles del juego (`game:publish` solo host dueño).

## 4. API HTTP (`server/platform/api.mjs`)

Público: `GET /api/platform/info`, `GET /api/events`, `GET /api/events/:id`, `POST /api/players`, `GET /api/me`,
`GET /api/events/:id/access`, `POST /api/events/:id/cards/free`, `POST /api/events/:id/orders`, `GET /api/orders/:id`,
`POST|GET /api/payments/:provider/webhook`, `POST /api/payments/mock/simulate` (solo proveedor mock).

Sesión con usuario y contraseña: `POST /api/auth/login` `{username,password}` → `{token, role, name}` (el servidor decide si es
PLATFORM_ADMIN o HOST; token `adm_…`/`sess_…` válido 30 días), `POST /api/auth/logout`, `GET /api/auth/me`,
`POST /api/auth/password` (animador cambia su contraseña). Contraseñas con scrypt; el usuario `admin` se define con
`PLATFORM_ADMIN_USER`/`PLATFORM_ADMIN_PASSWORD` en el servidor. Los tokens de API (`host_…`, `PLATFORM_ADMIN_TOKEN`) siguen valiendo para integraciones.

Animador (`Authorization: Bearer host_…` o token de sesión): `GET /api/host/me`, `GET|POST /api/host/events`, `GET|PATCH /api/host/events/:id`,
`PUT /api/host/events/:id/game`, `POST /api/host/events/:id/publish|start|finish`, `GET /api/host/events/:id/stats|players|orders`.

Administrador (`Bearer PLATFORM_ADMIN_TOKEN`): `GET /api/admin/stats`, `GET|POST /api/admin/hosts`, `PATCH /api/admin/hosts/:id`,
`POST /api/admin/hosts/:id/token`, `GET /api/admin/events`, `PATCH /api/admin/events/:id`, `GET|PUT /api/admin/settings`,
`GET|POST /api/admin/promotions`, `POST /api/admin/cards/complimentary`, `GET /api/admin/orders`, `POST /api/admin/orders/:id/refund`, `GET /api/admin/players`.

## 5. Eventos WebSocket

Sin eventos nuevos: se reutilizan `live:*` y `game:*` (ver `docs/BINGO_HIT_LIVE.md`). Cambios: `live:join` rechaza con
`card-required` / `purchase-required` / `event-suspended` cuando la sala pertenece a un evento de la plataforma y el jugador no
tiene acceso; `live:start` exige `canStartLive`; el rol `dj` lo obtiene solo el animador dueño del evento (o el admin).

## 6. Pagos (`server/platform/payments.mjs`)

`createPayment / confirmPayment / getPaymentStatus / handleWebhook / refundPayment`. Proveedores: **mock** (webhook firmado HMAC con
`MOCK_PAYMENT_SECRET`; simulador solo si `MOCK_PAYMENTS` no es `false`), **Transbank Webpay Plus** (REST v1.2, commit en
`return_url`), **Mercado Pago** (Checkout Pro; el webhook se verifica consultando `/v1/payments/{id}`). Las credenciales viven en
la configuración del servidor y el panel las muestra enmascaradas. Los dos proveedores reales están escritos contra la API
pública y quedan pendientes de validar en sus ambientes de integración.

## 7. Cómo probar

Local sin mediasoup: `npm run build && cd server && PLATFORM_ADMIN_TOKEN=admin-dev node dev-platform.mjs` → `http://127.0.0.1:3011/`
(usuario `admin`, contraseña `admin-dev`).
Completo: `docker compose --profile concert up -d --build` con `PLATFORM_ADMIN_TOKEN`, `PLATFORM_ADMIN_PASSWORD`, `PUBLIC_URL` y
`LIVE_HOST_TOKEN` en `.env` (`deploy/setup-server.sh` los genera).

**ADMIN + HOST**: portada → **Iniciar** (`#/login`) → usuario `admin` + contraseña → Animadores → crear (nombre, usuario y
contraseña) → marcar permisos (p. ej. "Tarjetas pagadas") → Guardar. El animador pulsa **Iniciar** con su usuario y contraseña
y entra en su panel (`#/events`): partida Spotify, eventos, 🎥 Transmitir (Bingo Hit Live) y 🎤 Karaoke (panel DJ) con la misma sesión.

**LOCAL + FREE**: animador → Nuevo evento → Presencial + Gratis → (opcional) usar la partida de Spotify actual → Crear → Publicar.
En `#/host` (partida Spotify) el panel "Bingo Hit Live" permite vincular la partida al evento; los jugadores del recinto
escanean el QR de "Repartir con QR" (flujo clásico sin checkout) o abren `#/event?e=…` y pulsan OBTENER MI TARJETA.

**ONLINE + FREE**: Online + Gratis → Publicar → el jugador abre `#/event?e=…` → nombre → OBTENER MI TARJETA → ✅ →
ENTRAR A BINGO HIT → tarjeta(s) con el vídeo del animador encima. El animador transmite desde "🎥 Transmitir".

**ONLINE + PAID**: Online + Pagadas (precio fijado por la plataforma salvo permiso `canSetCardPrice` + `hostCanSetPrice`) →
Publicar → jugador elige cantidad → COMPRAR Y JUGAR → página de pago (con el proveedor mock: "Simular pago aprobado") →
✅ COMPRA APROBADA → ENTRAR → varias tarjetas con pestañas. Antes del pago, `/api/events/:id/access` responde `purchase-required`.

**HOST + PLAYER**: ver `docs/BINGO_HIT_LIVE.md` § 6 (transmisión, bingo validado por el servidor, ganador).

Pruebas automáticas: `cd server && npm test` (unit + `platform.test.mjs`: roles, 6 combinaciones modalidad×tarjetas,
FREE con límites y acceso, PAID con webhook idempotente, reembolso, promociones, cortesías, configuración enmascarada + humo con
mediasoup). Navegador: recorrido admin → host → jugador (gratis y pagado, varias tarjetas, recuperación tras recargar).

## 8. Limitaciones y riesgos

- Almacén JSON en un solo servidor: para varios nodos o alto volumen, sustituir por SQL manteniendo la interfaz del `Store`.
- Transbank y Mercado Pago escritos contra su API pública sin validar en sandbox (necesitan credenciales reales).
- Identidad del jugador por token en el dispositivo (mínima fricción): recuperar tarjetas desde otro teléfono requiere el
  futuro login por email/teléfono.
- Liquidación a animadores no automatizada (conceptual: `hostSettlement`).
- HYBRID: `localCardDistribution` / `remoteCardDistribution` se guardan pero la adquisición aplica hoy la política general.
- El token del animador se guarda en `sessionStorage`; el del jugador en `localStorage`.
