/**
 * Consumo de los micrófonos del público en el lado del DJ / motor de audio. El servidor solo
 * autoriza consume a dj/admin/audio-engine (ver ConcertRoom.canConsume): el teléfono nunca consume.
 */

import type { MediasoupTransportLike } from './media-service.js';

export interface ConsumerAdapter {
  /** Devuelve la señal del producer indicado, lista para el motor de audio. */
  consume(producerId: string): Promise<MediaStream | AudioNode>;
  close(producerId: string): void;
  closeAll(): void;
}

export interface MediasoupRecvDeviceLike {
  loaded: boolean;
  rtpCapabilities: unknown;
  load(options: { routerRtpCapabilities: unknown }): Promise<void>;
  createRecvTransport(params: unknown): MediasoupRecvTransportLike;
}

export interface MediasoupConsumerLike {
  id: string;
  track: MediaStreamTrack;
  close(): void;
}

export interface MediasoupRecvTransportLike extends Pick<MediasoupTransportLike, 'id' | 'close' | 'getStats'> {
  on(event: 'connect', handler: (params: { dtlsParameters: unknown }, callback: () => void, errback: (err: Error) => void) => void): void;
  consume(options: { id: string; producerId: string; kind: string; rtpParameters: unknown; appData?: unknown }): Promise<MediasoupConsumerLike>;
}

export interface BTalkConsumeSignaling {
  routerRtpCapabilities(): Promise<unknown>;
  createWebRtcTransport(direction: 'recv'): Promise<unknown>;
  connectTransport(transportId: string, dtlsParameters: unknown): Promise<void>;
  consume(transportId: string, producerId: string, rtpCapabilities: unknown): Promise<{ id: string; producerId: string; kind: string; rtpParameters: unknown }>;
  resumeConsumer(consumerId: string): Promise<void>;
}

/** Un RECV transport para todos los micrófonos; un consumer por producer. */
export class BTalkConsumerAdapter implements ConsumerAdapter {
  private transport: MediasoupRecvTransportLike | null = null;
  private readonly consumers = new Map<string, MediasoupConsumerLike>();

  constructor(
    private readonly device: MediasoupRecvDeviceLike,
    private readonly signaling: BTalkConsumeSignaling,
  ) {}

  private async transportReady(): Promise<MediasoupRecvTransportLike> {
    if (this.transport) return this.transport;
    if (!this.device.loaded) await this.device.load({ routerRtpCapabilities: await this.signaling.routerRtpCapabilities() });
    const transport = this.device.createRecvTransport(await this.signaling.createWebRtcTransport('recv'));
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.signaling.connectTransport(transport.id, dtlsParameters).then(callback, errback);
    });
    this.transport = transport;
    return transport;
  }

  async consume(producerId: string): Promise<MediaStream> {
    const transport = await this.transportReady();
    const params = await this.signaling.consume(transport.id, producerId, this.device.rtpCapabilities);
    const consumer = await transport.consume({ ...params, appData: { source: 'crowd-mic' } });
    await this.signaling.resumeConsumer(consumer.id);
    this.consumers.set(producerId, consumer);
    return new MediaStream([consumer.track]);
  }

  close(producerId: string): void {
    this.consumers.get(producerId)?.close();
    this.consumers.delete(producerId);
  }

  closeAll(): void {
    for (const id of [...this.consumers.keys()]) this.close(id);
    this.transport?.close();
    this.transport = null;
  }

  async stats(): Promise<RTCStatsReport | null> {
    return this.transport ? this.transport.getStats() : null;
  }
}

/** Demo sin red: cada "micrófono" es un tono con vibrato y algo de ruido, para probar la cadena y los medidores. */
export class DemoConsumerAdapter implements ConsumerAdapter {
  private readonly nodes = new Map<string, { osc: OscillatorNode; lfo: OscillatorNode; out: GainNode }>();
  constructor(private readonly context: () => AudioContext | null) {}

  async consume(producerId: string): Promise<AudioNode> {
    const ctx = this.context();
    if (!ctx) throw new Error('Inicia el motor de audio para escuchar los micrófonos');
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 180 + (this.nodes.size % 4) * 60;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.5;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 6;
    lfo.connect(lfoGain).connect(osc.frequency);
    const out = ctx.createGain();
    out.gain.value = 0.15;
    osc.connect(out);
    osc.start();
    lfo.start();
    this.nodes.set(producerId, { osc, lfo, out });
    return out;
  }

  close(producerId: string): void {
    const n = this.nodes.get(producerId);
    if (!n) return;
    n.osc.stop();
    n.lfo.stop();
    n.out.disconnect();
    this.nodes.delete(producerId);
  }

  closeAll(): void {
    for (const id of [...this.nodes.keys()]) this.close(id);
  }
}
