/**
 * Cliente del participante (teléfono): une señalización y servicio de medios y refleja el estado
 * que dicta el servidor. Nunca decide por sí mismo pasar a LIVE: solo obedece `concert:state`.
 */

import { ConcertMediaService, MediaServiceError } from './media-service.js';
import { classifyQuality, type LinkStats } from './metrics.js';
import { EVENTS, type JoinAck, type JoinPayload, type ParticipantInfo, type ParticipantState, type PrepareOrder } from './protocol.js';
import type { ConcertSignaling } from './signaling.js';

export interface ParticipantIdentity {
  participantId: string;
  roomId: string;
  name: string;
  meta?: Partial<Omit<JoinPayload['meta'], 'name'>>;
}

export interface ParticipantSnapshot {
  state: ParticipantState;
  connected: boolean;
  slotId: string | null;
  error: string | null;
  micActive: boolean;
}

type Listener = (snapshot: ParticipantSnapshot) => void;

export class ParticipantClient {
  state: ParticipantState = 'DISCONNECTED';
  slotId: string | null = null;
  error: string | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly unsubscribe: (() => void)[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private preparing: Promise<void> | null = null;
  private joined = false;

  constructor(
    readonly signaling: ConcertSignaling,
    readonly media: ConcertMediaService,
    readonly identity: ParticipantIdentity,
    private readonly options: { heartbeatMs?: number; linkStats?: () => Promise<LinkStats | null> } = {},
  ) {}

  snapshot(): ParticipantSnapshot {
    return { state: this.state, connected: this.signaling.connected, slotId: this.slotId, error: this.error, micActive: this.media.state !== 'IDLE' };
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const snap = this.snapshot();
    this.listeners.forEach((l) => l(snap));
  }

  /** Conecta y hace join (o rejoin con el mismo participantId). Devuelve el estado que conserva el servidor. */
  async connect(): Promise<ParticipantState> {
    if (this.unsubscribe.length === 0) {
      this.unsubscribe.push(
        this.signaling.on(EVENTS.state, (info: ParticipantInfo) => void this.applyState(info)),
        this.signaling.on(EVENTS.prepare, (order: PrepareOrder) => void this.handlePrepare(order)),
        this.signaling.on(EVENTS.error, (err: { message?: string }) => {
          this.error = err?.message ?? 'Error';
          this.notify();
        }),
        this.signaling.onConnection((connected) => {
          if (!connected) {
            this.state = 'DISCONNECTED';
            this.notify();
          } else if (this.joined) {
            // Reconexión automática: rejoin con el mismo participantId para conservar el sitio.
            this.join().catch((err) => {
              this.error = err instanceof Error ? err.message : String(err);
              this.notify();
            });
          }
        }),
      );
    }
    await this.signaling.connect();
    const state = await this.join();
    if (this.options.heartbeatMs && !this.heartbeatTimer) this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.options.heartbeatMs);
    return state;
  }

  private async join(): Promise<ParticipantState> {
    const payload: JoinPayload = { participantId: this.identity.participantId, roomId: this.identity.roomId, meta: { ...this.identity.meta, name: this.identity.name } };
    const ack = await this.signaling.request<JoinAck>(EVENTS.join, payload);
    this.joined = true;
    this.state = ack.state;
    this.error = null;
    this.notify();
    return ack.state;
  }

  /** ESTOY DISPONIBLE: solo Socket.IO, ningún permiso de micrófono todavía. */
  async ready(): Promise<void> {
    await this.signaling.request(EVENTS.ready);
  }

  /** SALIR de la lista (y apagar el micrófono si estaba activo). */
  async leave(): Promise<void> {
    await this.media.stop();
    await this.signaling.request(EVENTS.leave);
    this.slotId = null;
    this.notify();
  }

  /** APAGAR MI MICRÓFONO: siempre permitido; primero se corta localmente, luego se avisa. */
  async stopMyMic(): Promise<void> {
    await this.media.stop();
    this.notify();
    await this.signaling.request(EVENTS.stopMyMic);
  }

  async disconnect(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    await this.media.stop();
    this.signaling.disconnect();
    this.unsubscribe.splice(0).forEach((u) => u());
    this.state = 'DISCONNECTED';
    this.notify();
  }

  private async heartbeat(): Promise<void> {
    const stats = this.options.linkStats ? await this.options.linkStats().catch(() => null) : null;
    this.signaling.send('concert:heartbeat', { quality: stats ? classifyQuality(stats) : 'UNKNOWN' });
  }

  private async handlePrepare(order: PrepareOrder): Promise<void> {
    this.preparing = (async () => {
      try {
        const payload = await this.media.prepare(order, { participantId: this.identity.participantId, roomId: this.identity.roomId });
        await this.signaling.request(EVENTS.prepared, payload);
      } catch (err) {
        const reason = err instanceof MediaServiceError ? err.reason : 'networkError';
        this.error = err instanceof Error ? err.message : String(err);
        await this.media.stop();
        await this.signaling.request(EVENTS.prepareFailed, { slotId: order.slotId, reason, detail: this.error }).catch(() => undefined);
        this.notify();
      }
    })();
    await this.preparing;
    this.preparing = null;
  }

  private async applyState(info: ParticipantInfo): Promise<void> {
    if (this.preparing) await this.preparing;
    this.state = info.state;
    this.slotId = info.slotId ?? null;
    try {
      switch (info.state) {
        case 'LIVE':
          if (this.media.state === 'PREPARED' || this.media.state === 'MUTED') await this.media.goLive();
          break;
        case 'MUTED':
          await this.media.mute();
          break;
        case 'PREPARING':
        case 'PREPARED':
          break;
        default:
          // READY, CONNECTED, ERROR, DISCONNECTED: cualquier recurso de medios sobra (END/CANCEL del DJ).
          if (this.media.state !== 'IDLE') await this.media.stop();
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
    this.notify();
  }
}
