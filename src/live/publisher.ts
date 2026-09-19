/**
 * LiveHostPublisher: el animador publica cámara + micrófono/mixer hacia el SFU (1 publisher → N viewers).
 * Selección de dispositivos, vista previa local, medidor de nivel, mute y estadísticas de envío.
 */

import { BTalkMediaAdapter, type ProducerHandle } from '../concert/media-service.js';
import { readLinkStats, type LinkStats } from '../concert/metrics.js';
import { loadMediasoupDevice, makeTransportSignaling } from '../concert/session.js';
import { LIVE_EVENTS, type LiveMetrics, type MediaKind } from './protocol.js';
import type { LiveSession } from './session.js';
import { LIVE_TRANSPORT_NAMES } from './viewer.js';

export interface DeviceLists {
  cameras: MediaDeviceInfo[];
  mics: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
}

export interface PublisherStats extends LinkStats {
  videoKbps: number;
  audioKbps: number;
  width?: number;
  height?: number;
  fps?: number;
}

export interface PublisherOptions {
  cameraId?: string;
  micId?: string;
  /** Sin procesado del navegador: la música del mixer debe llegar limpia. */
  rawAudio?: boolean;
  maxVideoKbps?: number;
  audioKbps?: number;
}

export class LiveHostPublisher {
  stream: MediaStream | null = null;
  private adapter: BTalkMediaAdapter | null = null;
  private readonly producers = new Map<MediaKind, ProducerHandle>();
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelBuf: Uint8Array<ArrayBuffer> | null = null;
  private lastBytes: { t: number; video: number; audio: number } | null = null;
  live = false;
  micMuted = false;
  camMuted = false;
  private readonly offs: (() => void)[] = [];

  constructor(
    readonly session: LiveSession,
    private options: PublisherOptions = {},
  ) {}

  static async devices(): Promise<DeviceLists> {
    const all = await navigator.mediaDevices.enumerateDevices();
    return { cameras: all.filter((d) => d.kind === 'videoinput'), mics: all.filter((d) => d.kind === 'audioinput'), speakers: all.filter((d) => d.kind === 'audiooutput') };
  }

  private constraints(): MediaStreamConstraints {
    const video: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
    if (this.options.cameraId) video.deviceId = { exact: this.options.cameraId };
    const raw = this.options.rawAudio !== false;
    const audio: MediaTrackConstraints = { echoCancellation: !raw, noiseSuppression: !raw, autoGainControl: !raw, channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 } };
    if (this.options.micId) audio.deviceId = { exact: this.options.micId };
    return { video, audio };
  }

  /** Vista previa local (pide permisos). Si ya está en directo, sustituye las pistas sin cortar la emisión. */
  async preview(options: Partial<PublisherOptions> = {}): Promise<MediaStream> {
    this.options = { ...this.options, ...options };
    const next = await navigator.mediaDevices.getUserMedia(this.constraints());
    const prev = this.stream;
    this.stream = next;
    for (const kind of ['video', 'audio'] as const) {
      const track = kind === 'video' ? next.getVideoTracks()[0] : next.getAudioTracks()[0];
      const producer = this.producers.get(kind);
      if (producer?.replaceTrack && track) await producer.replaceTrack(track);
    }
    prev?.getTracks().forEach((t) => t.stop());
    this.applyMutes();
    this.setupMeter(next);
    return next;
  }

  private setupMeter(stream: MediaStream): void {
    try {
      this.audioCtx ??= new AudioContext();
      this.analyser?.disconnect();
      const src = this.audioCtx.createMediaStreamSource(stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
      this.levelBuf = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
    } catch {
      this.analyser = null;
    }
  }

  /** Nivel de audio 0..1 (RMS) para el medidor. */
  level(): number {
    if (!this.analyser || !this.levelBuf) return 0;
    this.analyser.getByteTimeDomainData(this.levelBuf);
    let sum = 0;
    for (const v of this.levelBuf) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 3);
  }

  async goLive(): Promise<void> {
    if (!this.stream) await this.preview();
    const stream = this.stream as MediaStream;
    const ack = await this.session.connect();
    if (ack.role !== 'host') throw new Error('Este token no es de animador');
    if (!this.session.signaling) throw new Error('Sin conexión');
    if (!this.adapter) {
      const device = await loadMediasoupDevice(this.session.link.url);
      this.adapter = new BTalkMediaAdapter(device, makeTransportSignaling(this.session.signaling, LIVE_TRANSPORT_NAMES), ack.iceServers);
      await this.adapter.createSendTransport(undefined);
    }
    const video = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0];
    if (video && !this.producers.has('video')) {
      const maxBitrate = (this.options.maxVideoKbps ?? 1200) * 1000;
      this.producers.set('video', await this.adapter.produce(video, { source: 'live-host', mediaType: 'video' }, { codecOptions: { videoGoogleStartBitrate: 600 }, encodings: [{ maxBitrate }], paused: false }));
    }
    if (audio && !this.producers.has('audio')) {
      const maxBitrate = (this.options.audioKbps ?? 96) * 1000;
      this.producers.set('audio', await this.adapter.produce(audio, { source: 'live-host', mediaType: 'audio' }, { codecOptions: { opusStereo: true, opusDtx: false, opusFec: true, opusMaxAverageBitrate: maxBitrate }, encodings: [{ maxBitrate }], paused: false }));
    }
    await this.session.request(LIVE_EVENTS.start);
    this.live = true;
    this.offs.push(
      this.session.onJoin((_ack, reconnect) => {
        if (reconnect && this.live) void this.republish();
      }),
    );
  }

  /** Tras una reconexión el servidor ya no tiene nuestros producers: se vuelve a publicar. */
  private async republish(): Promise<void> {
    this.adapter?.closeTransport();
    this.adapter = null;
    this.producers.clear();
    this.live = false;
    await this.goLive();
  }

  private applyMutes(): void {
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !this.micMuted));
    this.stream?.getVideoTracks().forEach((t) => (t.enabled = !this.camMuted));
  }

  async setMuted(kind: MediaKind, muted: boolean): Promise<void> {
    if (kind === 'audio') this.micMuted = muted;
    else this.camMuted = muted;
    this.applyMutes();
    const producer = this.producers.get(kind);
    if (!producer || !this.session.connected) return;
    if (muted) await producer.pause();
    else await producer.resume();
    await this.session.request(muted ? LIVE_EVENTS.pauseProducer : LIVE_EVENTS.resumeProducer, { producerId: producer.id }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.offs.splice(0).forEach((off) => off());
    if (this.live && this.session.connected) await this.session.request(LIVE_EVENTS.stop).catch(() => undefined);
    this.live = false;
    for (const p of this.producers.values()) p.close();
    this.producers.clear();
    this.adapter?.closeTransport();
    this.adapter = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.analyser = null;
    this.lastBytes = null;
  }

  async stats(): Promise<PublisherStats | null> {
    const report = await this.adapter?.stats();
    if (!report) return null;
    const rows: Record<string, unknown>[] = [];
    report.forEach((r) => rows.push(r as unknown as Record<string, unknown>));
    const link = readLinkStats(rows);
    let video = 0;
    let audio = 0;
    let width: number | undefined;
    let height: number | undefined;
    let fps: number | undefined;
    for (const r of rows) {
      if (r.type !== 'outbound-rtp') continue;
      if (r.kind === 'video') {
        video += Number(r.bytesSent) || 0;
        if (typeof r.frameWidth === 'number') width = r.frameWidth;
        if (typeof r.frameHeight === 'number') height = r.frameHeight;
        if (typeof r.framesPerSecond === 'number') fps = r.framesPerSecond;
      } else if (r.kind === 'audio') audio += Number(r.bytesSent) || 0;
    }
    const now = Date.now();
    let videoKbps = 0;
    let audioKbps = 0;
    if (this.lastBytes) {
      const dt = (now - this.lastBytes.t) / 1000;
      if (dt > 0) {
        videoKbps = Math.round(((video - this.lastBytes.video) * 8) / 1000 / dt);
        audioKbps = Math.round(((audio - this.lastBytes.audio) * 8) / 1000 / dt);
      }
    }
    this.lastBytes = { t: now, video, audio };
    const out: PublisherStats = { ...link, videoKbps, audioKbps };
    if (width !== undefined) out.width = width;
    if (height !== undefined) out.height = height;
    if (fps !== undefined) out.fps = fps;
    return out;
  }

  metrics(): Promise<LiveMetrics & { ok: boolean }> {
    return this.session.request<LiveMetrics>(LIVE_EVENTS.metrics);
  }
}
