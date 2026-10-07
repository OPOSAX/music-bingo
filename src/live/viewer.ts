/**
 * LiveViewer: recibe cámara y audio del animador (solo consume; nunca publica). Reconstruye el
 * transporte al reconectar y expone un único MediaStream con vídeo + audio para el <video>.
 */

import { BTalkConsumerAdapter } from '../concert/consumer.js';
import { loadMediasoupDevice, makeTransportSignaling } from '../concert/session.js';
import { LIVE_EVENTS, type LinkState, type LiveProducerInfo, type LiveState, type MediaKind } from './protocol.js';
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
  /** Cámara del invitado que canta o habla (null cuando se retira). */
  onGuest?(stream: MediaStream | null, name: string): void;
  onLive?(state: LiveState | null): void;
  onLink?(state: LinkState): void;
  onHost?(online: boolean): void;
  onViewers?(count: number): void;
  onProducerState?(info: LiveProducerInfo): void;
}

export interface ViewerOptions {
  /** 'guest': solo la cámara del invitado (p. ej. el animador, que no debe consumir su propia transmisión). */
  only?: 'guest';
}

export class LiveViewer {
  readonly stream = new MediaStream();
  readonly guestStream = new MediaStream();
  guestName = '';
  live: LiveState | null = null;
  private adapter: BTalkConsumerAdapter | null = null;
  private readonly consumed = new Set<string>();
  private readonly offs: (() => void)[] = [];
  private stopped = false;

  constructor(
    readonly session: LiveSession,
    private readonly cb: ViewerCallbacks = {},
    private readonly options: ViewerOptions = {},
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
        if (p.source === 'live-guest') return void this.consumeGuest(p);
        if (this.options.only === 'guest') return;
        if (!this.live) this.live = { active: true, startedAt: Date.now(), producers: [] };
        this.live.producers.push(p);
        if (p.kind === 'audio') this.syncGuestAudio();
        void this.consume(p);
      }),
      this.session.on(LIVE_EVENTS.producerRemoved, (p: { producerId: string }) => this.dropGuest(p.producerId)),
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
    for (const g of ack.live.guests ?? []) void this.consumeGuest(g);
    if (this.options.only !== 'guest') await this.apply(ack.live.active ? ack.live : null);
  }

  /** Producers del invitado por tipo (vídeo: cámara; audio: su voz, solo cuando el animador no transmite). */
  private readonly guestProducers = new Map<MediaKind, string>();
  private readonly guestAudioPending = new Map<string, LiveProducerInfo>();

  /** ¿La voz del invitado llega por la mezcla del animador? Entonces no se consume aparte (se oiría doble). */
  private get hostCarriesGuestAudio(): boolean {
    return !!this.live?.active && this.options.only !== 'guest' && this.live.producers.some((p) => p.kind === 'audio');
  }

  /** Un invitado a la vez: el último que enciende la cámara sustituye al anterior. */
  private async consumeGuest(p: LiveProducerInfo): Promise<void> {
    if (this.stopped || this.consumed.has(p.producerId)) return;
    if (p.kind === 'audio') {
      if (this.options.only === 'guest') return; // el animador ya oye al invitado por su PA/mezcla
      this.guestAudioPending.set(p.producerId, p);
      if (this.hostCarriesGuestAudio) return;
    }
    this.consumed.add(p.producerId);
    try {
      const adapter = await this.ensureAdapter();
      const single = await adapter.consume(p.producerId);
      const previous = this.guestProducers.get(p.kind);
      if (previous && previous !== p.producerId) this.adapter?.close(previous);
      for (const old of this.guestStream.getTracks()) if (old.kind === p.kind) this.guestStream.removeTrack(old);
      for (const t of single.getTracks()) this.guestStream.addTrack(t);
      this.guestProducers.set(p.kind, p.producerId);
      this.guestName = p.name ?? this.guestName;
      this.cb.onGuest?.(this.guestStream, this.guestName);
    } catch (err) {
      this.consumed.delete(p.producerId);
      console.warn('No se pudo recibir al invitado', p.kind, err);
    }
  }

  private dropGuest(producerId: string): void {
    this.consumed.delete(producerId);
    this.guestAudioPending.delete(producerId);
    this.adapter?.close(producerId);
    const kind = [...this.guestProducers].find(([, id]) => id === producerId)?.[0];
    if (!kind) return;
    this.guestProducers.delete(kind);
    for (const old of this.guestStream.getTracks()) if (old.kind === kind) this.guestStream.removeTrack(old);
    if (this.guestProducers.size === 0) {
      this.cb.onGuest?.(null, this.guestName);
      this.guestName = '';
    } else this.cb.onGuest?.(this.guestStream, this.guestName);
  }

  /** Al empezar o terminar la transmisión del animador: la voz del invitado cambia de camino (mezcla ↔ directa). */
  private syncGuestAudio(): void {
    const current = this.guestProducers.get('audio');
    if (this.hostCarriesGuestAudio) {
      if (current) this.dropGuest(current);
      return;
    }
    if (current) return;
    const pending = [...this.guestAudioPending.values()].at(-1);
    if (pending) void this.consumeGuest(pending);
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
      this.syncGuestAudio();
      return;
    }
    this.live = state;
    this.cb.onLive?.(state);
    this.syncGuestAudio();
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
    for (const id of [...this.guestProducers.values()]) this.dropGuest(id);
    this.guestAudioPending.clear();
    for (const g of state.guests ?? []) void this.consumeGuest(g);
    if (this.options.only !== 'guest') await this.apply(state.active ? state : null);
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
