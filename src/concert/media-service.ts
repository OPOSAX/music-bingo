/**
 * Servicio de medios del participante (teléfono). Regla de oro del Concert Mode:
 *  - READY no toca getUserMedia ni crea transports/producers.
 *  - PREPARE crea SOLO el SEND transport y UN producer de audio en pausa.
 *  - GO LIVE reanuda el producer; MUTE lo pausa; END/CANCEL cierra todo y detiene las pistas.
 * El transporte real lo entrega un adaptador (B-Talk/mediasoup-client). Para pruebas y demo
 * existe LocalMediaAdapter, que no usa red.
 */

import type { AudioProfile, CrowdMicAppData, PrepareFailureReason, PrepareOrder, PreparedPayload } from './protocol.js';

/** Restricciones de captura por perfil. El teléfono está junto al PA, así que el AEC del navegador siempre va activo. */
export function micConstraints(profile: AudioProfile, deviceId?: string): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
    echoCancellation: true,
    // SING conserva la dinámica y los armónicos: sin supresor ni AGC del navegador (los aplica el motor del DJ).
    noiseSuppression: profile === 'TALK',
    autoGainControl: profile === 'TALK',
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio, video: false };
}

/** Sugerencias de codificación Opus para mediasoup-client (`codecOptions` y `encodings`). */
export function opusOptions(profile: AudioProfile): { codecOptions: Record<string, unknown>; encodings: { maxBitrate: number }[] } {
  return {
    codecOptions: {
      opusStereo: false,
      opusFec: true,
      opusDtx: profile === 'TALK', // DTX ahorra ancho de banda al hablar; al cantar recorta colas de notas
      opusMaxPlaybackRate: 48000,
      opusMaxAverageBitrate: profile === 'SING' ? 64000 : 32000,
    },
    encodings: [{ maxBitrate: profile === 'SING' ? 64000 : 32000 }],
  };
}

export interface ProducerHandle {
  readonly id: string;
  readonly paused: boolean;
  readonly closed: boolean;
  pause(): Promise<void> | void;
  resume(): Promise<void> | void;
  close(): void;
}

export interface ProduceOptions {
  codecOptions: Record<string, unknown>;
  encodings: { maxBitrate: number }[];
}

/** Adaptador de transporte: lo implementa B-Talk (mediasoup-client) o el adaptador local. */
export interface MediaTransportAdapter {
  /** Crea el SEND transport con los parámetros que envió el servidor en la orden PREPARE. */
  createSendTransport(params: unknown): Promise<void>;
  /** Crea el producer de audio. Debe devolverlo ya en pausa (el servidor lo crea con paused:true). */
  produce(track: MediaStreamTrack, appData: CrowdMicAppData, options: ProduceOptions): Promise<ProducerHandle>;
  closeTransport(): void;
}

export type MediaState = 'IDLE' | 'PREPARING' | 'PREPARED' | 'LIVE' | 'MUTED';

export class MediaServiceError extends Error {
  constructor(
    readonly reason: PrepareFailureReason,
    message: string,
  ) {
    super(message);
  }
}

type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<MediaStream>;

export class ConcertMediaService {
  state: MediaState = 'IDLE';
  private stream: MediaStream | null = null;
  private producer: ProducerHandle | null = null;
  private slotId: string | null = null;
  readonly gumCalls: number = 0;

  constructor(
    private readonly adapter: MediaTransportAdapter,
    private readonly getUserMedia: GetUserMedia = (c) => navigator.mediaDevices.getUserMedia(c),
    private readonly options: { deviceId?: string } = {},
  ) {}

  get producerId(): string | null {
    return this.producer?.id ?? null;
  }

  get currentSlot(): string | null {
    return this.slotId;
  }

  get track(): MediaStreamTrack | null {
    return this.stream?.getAudioTracks()[0] ?? null;
  }

  /** PREPARE: permiso de micrófono → SEND transport → producer en pausa. Devuelve el payload de `concert:prepared`. */
  async prepare(order: PrepareOrder, identity: { participantId: string; roomId: string }): Promise<PreparedPayload> {
    if (this.state !== 'IDLE') await this.stop();
    this.state = 'PREPARING';
    this.slotId = order.slotId;
    try {
      (this as { gumCalls: number }).gumCalls++;
      try {
        this.stream = await this.getUserMedia(micConstraints(order.profile, this.options.deviceId));
      } catch (err) {
        throw new MediaServiceError('permissionDenied', `No se pudo acceder al micrófono: ${String((err as Error)?.message ?? err)}`);
      }
      const track = this.stream.getAudioTracks()[0];
      if (!track) throw new MediaServiceError('permissionDenied', 'El micrófono no entregó ninguna pista de audio');
      try {
        await this.adapter.createSendTransport(order.transport);
      } catch (err) {
        throw new MediaServiceError('transportFailed', `No se pudo crear el transporte: ${String((err as Error)?.message ?? err)}`);
      }
      const appData: CrowdMicAppData = { mediaType: 'audio', source: 'crowd-mic', participantId: identity.participantId, roomId: identity.roomId, slotId: order.slotId };
      try {
        this.producer = await this.adapter.produce(track, appData, opusOptions(order.profile));
        if (!this.producer.paused) await this.producer.pause();
      } catch (err) {
        throw new MediaServiceError('producerFailed', `No se pudo crear el producer: ${String((err as Error)?.message ?? err)}`);
      }
      this.state = 'PREPARED';
      return { slotId: order.slotId, producerId: this.producer.id };
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  /** GO LIVE: reanuda el producer (el servidor ya reanudó el suyo). */
  async goLive(): Promise<void> {
    if (!this.producer || (this.state !== 'PREPARED' && this.state !== 'MUTED')) throw new Error(`No se puede pasar a LIVE desde ${this.state}`);
    await this.producer.resume();
    this.state = 'LIVE';
  }

  async mute(): Promise<void> {
    if (!this.producer || this.state !== 'LIVE') return;
    await this.producer.pause();
    this.state = 'MUTED';
  }

  /** END / CANCEL / SALIR: cierra producer y transporte y detiene las pistas (apaga el indicador del micrófono). */
  async stop(): Promise<void> {
    try {
      this.producer?.close();
    } catch {
      /* ya cerrado */
    }
    this.producer = null;
    this.adapter.closeTransport();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.slotId = null;
    this.state = 'IDLE';
  }
}

/* ---------------- Adaptador local (pruebas y demo sin red) ---------------- */

export class LocalProducer implements ProducerHandle {
  paused = true;
  closed = false;
  constructor(
    readonly id: string,
    readonly track: MediaStreamTrack,
    readonly appData: CrowdMicAppData,
  ) {}
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  close(): void {
    this.closed = true;
    this.paused = true;
  }
}

/** Mantiene los producers en memoria; el "servidor" local los consulta para simular el consume del DJ. */
export class LocalMediaAdapter implements MediaTransportAdapter {
  transportOpen = false;
  transportsCreated = 0;
  readonly producers: LocalProducer[] = [];
  constructor(private readonly onProduce?: (producer: LocalProducer) => string | void) {}

  async createSendTransport(): Promise<void> {
    this.transportOpen = true;
    this.transportsCreated++;
  }

  async produce(track: MediaStreamTrack, appData: CrowdMicAppData): Promise<ProducerHandle> {
    if (!this.transportOpen) throw new Error('transport cerrado');
    const id = `prod-${appData.participantId}-${this.producers.length + 1}`;
    const producer = new LocalProducer(id, track, appData);
    this.producers.push(producer);
    this.onProduce?.(producer);
    return producer;
  }

  closeTransport(): void {
    this.transportOpen = false;
    for (const p of this.producers) p.close();
  }
}

/* ---------------- Adaptador B-Talk (mediasoup-client) ---------------- */

/** Subconjunto de mediasoup-client que usamos, tipado a mano para no depender del paquete en este repo. */
export interface MediasoupDeviceLike {
  loaded: boolean;
  load(options: { routerRtpCapabilities: unknown }): Promise<void>;
  rtpCapabilities: unknown;
  createSendTransport(params: unknown): MediasoupTransportLike;
}

export interface MediasoupTransportLike {
  id: string;
  on(event: 'connect', handler: (params: { dtlsParameters: unknown }, callback: () => void, errback: (err: Error) => void) => void): void;
  on(event: 'produce', handler: (params: { kind: string; rtpParameters: unknown; appData: unknown }, callback: (data: { id: string }) => void, errback: (err: Error) => void) => void): void;
  on(event: 'connectionstatechange', handler: (state: string) => void): void;
  produce(options: { track: MediaStreamTrack; appData: unknown; codecOptions?: unknown; encodings?: unknown; stopTracks?: boolean; zeroRtpOnPause?: boolean }): Promise<MediasoupProducerLike>;
  close(): void;
  getStats(): Promise<RTCStatsReport>;
}

export interface MediasoupProducerLike {
  id: string;
  paused: boolean;
  closed: boolean;
  pause(): void;
  resume(): void;
  close(): void;
}

/** Señalización que B-Talk expone para el transporte (createWebRtcTransport / connectTransport / produce). */
export interface BTalkTransportSignaling {
  routerRtpCapabilities(): Promise<unknown>;
  createWebRtcTransport(): Promise<unknown>;
  connectTransport(transportId: string, dtlsParameters: unknown): Promise<void>;
  produce(transportId: string, kind: string, rtpParameters: unknown, appData: unknown): Promise<{ id: string }>;
}

/**
 * Integra con RoomClient de B-Talk: el teléfono solo crea el SEND transport. Nunca crea el RECV
 * transport ni consume nada (el participante no debe oír a otros micrófonos).
 */
export class BTalkMediaAdapter implements MediaTransportAdapter {
  private transport: MediasoupTransportLike | null = null;
  onConnectionState: ((state: string) => void) | null = null;

  constructor(
    private readonly device: MediasoupDeviceLike,
    private readonly signaling: BTalkTransportSignaling,
  ) {}

  async createSendTransport(params: unknown): Promise<void> {
    if (!this.device.loaded) this.device.load({ routerRtpCapabilities: await this.signaling.routerRtpCapabilities() });
    const transportParams = params ?? (await this.signaling.createWebRtcTransport());
    const transport = this.device.createSendTransport(transportParams);
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.signaling.connectTransport(transport.id, dtlsParameters).then(callback, errback);
    });
    transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
      this.signaling.produce(transport.id, kind, rtpParameters, appData).then(callback, errback);
    });
    transport.on('connectionstatechange', (state) => this.onConnectionState?.(state));
    this.transport = transport;
  }

  async produce(track: MediaStreamTrack, appData: CrowdMicAppData, options: ProduceOptions): Promise<ProducerHandle> {
    if (!this.transport) throw new Error('SEND transport no creado');
    const producer = await this.transport.produce({ track, appData, codecOptions: options.codecOptions, encodings: options.encodings, stopTracks: false, zeroRtpOnPause: true });
    producer.pause();
    return {
      id: producer.id,
      get paused() {
        return producer.paused;
      },
      get closed() {
        return producer.closed;
      },
      pause: () => producer.pause(),
      resume: () => producer.resume(),
      close: () => producer.close(),
    };
  }

  closeTransport(): void {
    this.transport?.close();
    this.transport = null;
  }

  /** Estadísticas WebRTC del transporte (RTT, jitter, pérdidas) para el monitor de calidad. */
  async stats(): Promise<RTCStatsReport | null> {
    return this.transport ? this.transport.getStats() : null;
  }
}
