/**
 * Sesión Live: una conexión Socket.IO por página hacia el servidor Bingo Hit Live (el servidor Concert),
 * compartida por el plano de juego y el plano de vídeo. Se une automáticamente a la sala derivada del evento.
 */

import { connectBTalk, type ConcertSignaling } from '../concert/signaling.js';
import { LIVE_EVENTS, liveRoomId, type LinkState, type LiveJoinAck } from './protocol.js';

export interface LiveLink {
  /** URL base del servidor Live (sin barra final). */
  url: string;
  /** Identificador del evento (código de partida). */
  event: string;
}

const sessions = new Map<string, LiveSession>();

/** Devuelve la sesión compartida para ese servidor+evento (se crea si no existe). */
export function liveSession(link: LiveLink, options: { token?: string; name?: string } = {}): LiveSession {
  const key = `${link.url}|${link.event}|${options.token ? 'host' : 'viewer'}`;
  let s = sessions.get(key);
  if (!s) {
    s = new LiveSession(link, options);
    sessions.set(key, s);
  }
  return s;
}

export function releaseLiveSessions(): void {
  for (const s of sessions.values()) s.close();
  sessions.clear();
}

export class LiveSession {
  readonly roomId: string;
  signaling: ConcertSignaling | null = null;
  ack: LiveJoinAck | null = null;
  state: LinkState = 'OFFLINE';
  private connecting: Promise<LiveJoinAck> | null = null;
  private readonly listeners = new Set<(state: LinkState) => void>();
  private reconnectCount = 0;
  private closed = false;

  constructor(
    readonly link: LiveLink,
    private readonly options: { token?: string; name?: string },
  ) {
    this.roomId = liveRoomId(link.event);
  }

  get connected(): boolean {
    return this.signaling?.connected === true && this.ack !== null;
  }

  get reconnections(): number {
    return this.reconnectCount;
  }

  onState(listener: (state: LinkState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(state: LinkState): void {
    if (this.state === state) return;
    this.state = state;
    this.listeners.forEach((l) => l(state));
  }

  /** Conecta y hace `live:join`. Idempotente: varias llamadas comparten la misma conexión. */
  async connect(): Promise<LiveJoinAck> {
    if (this.ack && this.signaling?.connected) return this.ack;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const auth: { roomId: string; token?: string } = { roomId: this.roomId };
      if (this.options.token) auth.token = this.options.token;
      if (!this.signaling) {
        this.signaling = await connectBTalk(this.link.url, auth);
        this.signaling.onConnection((up) => {
          if (this.closed) return;
          if (!up) {
            this.ack = null;
            this.setState('RECONNECTING');
            return;
          }
          // Reconexión automática de Socket.IO: volver a unirse a la sala con el mismo estado.
          this.reconnectCount++;
          this.join(true).catch(() => this.setState('INTERRUPTED'));
        });
      }
      this.setState(this.state === 'OFFLINE' ? 'RECONNECTING' : this.state);
      await this.signaling.connect();
      return this.join(false);
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async join(reconnect: boolean): Promise<LiveJoinAck> {
    if (!this.signaling) throw new Error('Sin conexión');
    const payload: { name?: string; reconnect?: boolean } = {};
    if (this.options.name) payload.name = this.options.name;
    if (reconnect) payload.reconnect = true;
    const ack = await this.signaling.request<LiveJoinAck>(LIVE_EVENTS.join, payload);
    this.ack = ack;
    this.setState('LIVE');
    this.rejoinListeners.forEach((l) => l(ack, reconnect));
    return ack;
  }

  private readonly rejoinListeners = new Set<(ack: LiveJoinAck, reconnect: boolean) => void>();

  /** Se dispara tras cada join (también tras reconectar), con el acuse del servidor. */
  onJoin(listener: (ack: LiveJoinAck, reconnect: boolean) => void): () => void {
    this.rejoinListeners.add(listener);
    return () => this.rejoinListeners.delete(listener);
  }

  on(event: string, handler: (payload: any) => void): () => void {
    if (!this.signaling) throw new Error('Llama a connect() antes de suscribirte');
    return this.signaling.on(event, handler);
  }

  request<T = Record<string, unknown>>(event: string, payload?: unknown): Promise<T & { ok: boolean }> {
    if (!this.signaling) return Promise.reject(new Error('Sin conexión'));
    return this.signaling.request<T>(event, payload);
  }

  close(): void {
    this.closed = true;
    this.signaling?.disconnect();
    this.signaling = null;
    this.ack = null;
    this.setState('OFFLINE');
  }
}
