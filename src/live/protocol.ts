/**
 * Bingo Hit Live — contrato compartido entre el animador (HOST), los jugadores (VIEWER) y el servidor.
 *
 * Dos planos separados sobre el mismo socket:
 *  - MEDIA PLANE (WebRTC/mediasoup): cámara, micrófono y audio del evento. Eventos `live:*` de transporte.
 *  - GAME PLANE (Socket.IO): estado de la partida, canción actual, tarjetas, bingos, ganador, reacciones.
 *    Reutiliza los mensajes de sincronización existentes (SyncState / pool / claim) transportados por `game:*`.
 */

export type LiveRole = 'host' | 'viewer';

/** Identificador de sala WebRTC derivado del evento (el jugador nunca lo escribe). */
export function liveRoomId(eventId: string): string {
  return `bingo-${eventId}`;
}

export const LIVE_EVENTS = {
  // Sesión
  join: 'live:join', // cliente → servidor (ack: LiveJoinAck)
  hostOnline: 'live:host_online',
  hostOffline: 'live:host_offline',
  playersCount: 'live:players_count',
  // Transmisión
  start: 'live:start', // host → servidor
  stop: 'live:stop', // host → servidor
  started: 'live:started', // servidor → todos { producers }
  stopped: 'live:stopped',
  producerAdded: 'live:producer_added',
  producerState: 'live:producer_state', // { producerId, kind, paused }
  pauseProducer: 'live:pause-producer',
  resumeProducer: 'live:resume-producer',
  // Transporte (envoltorios de los handlers de B-Talk)
  rtpCapabilities: 'live:rtp-capabilities',
  createTransport: 'live:create-transport',
  connectTransport: 'live:connect-transport',
  produce: 'live:produce',
  consume: 'live:consume',
  resumeConsumer: 'live:resume-consumer',
  // Juego
  gamePublish: 'game:publish', // host → servidor { message } (SyncState / pool / cfg)
  gameClaim: 'game:claim', // jugador → servidor → hosts { message } (petición de tarjeta)
  gameMessage: 'game:message', // servidor → clientes { message }
  bingo: 'live:bingo', // jugador → servidor
  bingoClaimed: 'live:bingo_claimed', // servidor → hosts (con veredicto del servidor)
  winner: 'live:winner', // host → servidor
  winnerAnnounced: 'live:winner_announced', // servidor → todos
  // Reacciones y métricas
  reaction: 'live:reaction',
  reactions: 'live:reactions',
  metrics: 'live:metrics',
  stats: 'live:stats',
} as const;

export type MediaKind = 'audio' | 'video';

export interface LiveProducerInfo {
  producerId: string;
  kind: MediaKind;
  paused: boolean;
}

export interface LiveState {
  active: boolean;
  startedAt: number | null;
  producers: LiveProducerInfo[];
}

export interface LiveJoinPayload {
  name?: string;
}

export interface LiveJoinAck {
  ok: true;
  role: LiveRole;
  roomId: string;
  hostOnline: boolean;
  live: LiveState;
  viewers: number;
  iceServers: RTCIceServer[];
  /** Histórico del plano de juego (cfg, trozos del pool y último estado) para quien llega tarde. */
  history: string[];
}

/** Configuración de la partida publicada por el anfitrión para que el servidor pueda validar bingos y `/play` construir tarjetas. */
export interface GameConfigMessage {
  k: 'cfg';
  seed: string;
  gridSize: 3 | 4 | 5;
  freeCenter: boolean;
  cardCount: number;
  poolSize: number;
  /** Canal ntfy de la partida (compatibilidad con jugadores sin servidor). */
  topic: string;
  title: string;
}

export interface BingoClaim {
  seed: string;
  index: number;
  name: string;
  cid: string;
  kind: 'line' | 'full';
  t: number;
}

export interface BingoClaimed extends BingoClaim {
  /** Veredicto del servidor con el último estado publicado: null si no pudo comprobarlo. */
  valid: boolean | null;
  serverStatus?: 'none' | 'line' | 'full';
}

export interface WinnerAnnouncement {
  seed: string;
  index: number;
  name: string;
  kind: 'line' | 'full';
  t: number;
}

export const REACTIONS = ['❤️', '👏', '🔥', '🍻', '🎉'] as const;
export type Reaction = (typeof REACTIONS)[number];

export interface ReactionBatch {
  counts: Partial<Record<Reaction, number>>;
  t: number;
}

export interface LiveMetrics {
  viewers: number;
  viewersPeak: number;
  joins: number;
  disconnects: number;
  reconnections: number;
  avgConnectedMs: number;
  bingos: number;
  reactions: number;
  webrtcErrors: number;
  hostOnline: boolean;
  live: LiveState;
}

export type LinkState = 'LIVE' | 'RECONNECTING' | 'INTERRUPTED' | 'OFFLINE';
