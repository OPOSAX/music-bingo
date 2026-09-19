/**
 * LiveViewer: recibe cámara y audio del animador (solo consume; nunca publica). Reconstruye el
 * transporte al reconectar y expone un único MediaStream con vídeo + audio para el <video>.
 */

import { BTalkConsumerAdapter } from '../concert/consumer.js';
import { loadMediasoupDevice, makeTransportSignaling } from '../concert/session.js';
import { LIVE_EVENTS, type LinkState, type LiveProducerInfo, type LiveState } from './protocol.js';
import type { LiveSession } from './session.js';

export const LIVE_TRANSPORT_NAMES = {
  rtpCapabilities: LIVE_EVENTS.rtpCapabilities,
  createTransport: LIVE_EVENTS.createTransport,
  connectTransport: LIVE_EVENTS.connectTransport,
  produce: LIVE_EVENTS.produce,
  consume: LIVE_EVENTS.consume,
  resumeConsumer: LIVE_EVENTS.resumeConsumer,
} as const;

export interface ViewerCallbacks {
  onStream?(stream: MediaStream): void;
  onLive?(state: LiveState | null): void;
  onLink?(state: LinkState): void;
  onHost?(online: boolean): void;
  onViewers?(count: number): void;
  onProducerState?(info: LiveProducerInfo): void;
}

export class LiveViewer {
  readonly stream = new MediaStream();
  live: LiveState | null = null;
  private adapter: BTalkConsumerAdapter | null = null;
  private readonly consumed = new Set<string>();
  private readonly offs: (() => void)[] = [];
  private stopped = false;

  constructor(
    readonly session: LiveSession,
    private readonly cb: ViewerCallbacks = {},
  ) {}

  async start(): Promise<void> {
    const ack = await this.session.connect();
    if (this.stopped) return;
    this.offs.push(
      this.session.onState((s) => this.cb.onLink?.(s)),
      this.session.onJoin((again, reconnect) => {
        if (reconnect) void this.rebuild(again.live);
      }),
      this.session.on(LIVE_EVENTS.started, (state: LiveState) => void this.apply(state)),
      this.session.on(LIVE_EVENTS.stopped, () => this.clear()),
      this.session.on(LIVE_EVENTS.producerAdded, (p: LiveProducerInfo) => {
        if (!this.live) this.live = { active: true, startedAt: Date.now(), producers: [] };
        this.live.producers.push(p);
        void this.consume(p);
      }),
      this.session.on(LIVE_EVENTS.producerState, (p: LiveProducerInfo) => this.cb.onProducerState?.(p)),
      this.session.on(LIVE_EVENTS.hostOnline, () => this.cb.onHost?.(true)),
      this.session.on(LIVE_EVENTS.hostOffline, () => this.cb.onHost?.(false)),
      this.session.on(LIVE_EVENTS.playersCount, (p: { viewers: number; hostOnline: boolean }) => {
        this.cb.onViewers?.(p.viewers);
        this.cb.onHost?.(p.hostOnline);
      }),
    );
    this.cb.onHost?.(ack.hostOnline);
    this.cb.onViewers?.(ack.viewers);
    this.cb.onLink?.(this.session.state);
    await this.apply(ack.live.active ? ack.live : null);
  }

  private async ensureAdapter(): Promise<BTalkConsumerAdapter> {
    if (this.adapter) return this.adapter;
    if (!this.session.signaling) throw new Error('Sin conexión');
    const device = await loadMediasoupDevice(this.session.link.url);
    this.adapter = new BTalkConsumerAdapter(device, makeTransportSignaling(this.session.signaling, LIVE_TRANSPORT_NAMES), this.session.ack?.iceServers ?? []);
    return this.adapter;
  }

  private async apply(state: LiveState | null): Promise<void> {
    if (!state || !state.active) {
      this.clear();
      return;
    }
    this.live = state;
    this.cb.onLive?.(state);
    for (const p of state.producers) await this.consume(p);
  }

  private async consume(p: LiveProducerInfo): Promise<void> {
    if (this.stopped || this.consumed.has(p.producerId)) return;
    this.consumed.add(p.producerId);
    try {
      const adapter = await this.ensureAdapter();
      const single = await adapter.consume(p.producerId);
      for (const t of single.getTracks()) {
        for (const old of this.stream.getTracks()) if (old.kind === t.kind) this.stream.removeTrack(old);
        this.stream.addTrack(t);
      }
      this.cb.onStream?.(this.stream);
    } catch (err) {
      this.consumed.delete(p.producerId);
      console.warn('No se pudo recibir', p.kind, err);
      this.cb.onLink?.('INTERRUPTED');
    }
  }

  /** Tras reconectar: el transporte anterior ya no existe en el servidor. */
  private async rebuild(state: LiveState): Promise<void> {
    this.adapter?.closeAll();
    this.adapter = null;
    this.consumed.clear();
    for (const old of this.stream.getTracks()) this.stream.removeTrack(old);
    await this.apply(state.active ? state : null);
  }

  private clear(): void {
    this.live = null;
    this.adapter?.closeAll();
    this.adapter = null;
    this.consumed.clear();
    for (const old of this.stream.getTracks()) this.stream.removeTrack(old);
    this.cb.onLive?.(null);
  }

  stop(): void {
    this.stopped = true;
    this.offs.splice(0).forEach((off) => off());
    this.clear();
  }
}
