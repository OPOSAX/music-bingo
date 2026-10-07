/**
 * Mesa de mezcla del anfitrión para transmitir a los jugadores: micrófono del animador + música + cantantes del
 * karaoke → una sola pista de audio que publica el servidor Live (mediasoup). Los jugadores la oyen desde su
 * tarjeta (#/play) y, si el animador les da paso, cantan o hablan y su voz entra en la misma mezcla.
 *
 *   mic (VoiceChain) ─┐
 *   música ───────────┼─▶ bus ─▶ MediaStreamDestination ─▶ LiveHostPublisher (WebRTC)
 *   karaoke (tap) ────┘    └─▶ monitor (altavoces/PA de este equipo, sin el micrófono para no acoplar)
 *
 * La música puede venir de una entrada de audio (mezclador USB, loopback como "Stereo Mix" o VB-Cable) o del audio
 * de esta misma pestaña (captura de pantalla con audio: el navegador pregunta y hay que marcar "Compartir audio").
 */

import { getSharedAudioContext } from '../concert/audio/shared-context.js';
import { VoiceChain } from '../concert/audio/voice-chain.js';
import { addKaraokeTap, removeKaraokeTap } from '../concert/views/karaoke-host-panel.js';
import { localPlayer } from '../local-player.js';

/** 'local': el reproductor de la biblioteca propia (sin captura ni loopback: la señal entra directa). */
export type MusicSource = 'none' | 'tab' | 'device' | 'local';

export interface BroadcastSettings {
  micId: string;
  micDb: number;
  musicSource: MusicSource;
  musicDeviceId: string;
  musicDb: number;
  /** Escuchar música y cantantes también por este equipo. */
  monitor: boolean;
  /** Emitir también la cámara del animador. */
  camera: boolean;
  cameraId: string;
}

export const DEFAULT_BROADCAST: BroadcastSettings = { micId: '', micDb: 6, musicSource: 'none', musicDeviceId: '', musicDb: 0, monitor: true, camera: false, cameraId: '' };

const KEY = 'live:broadcast';

export function loadBroadcastSettings(): BroadcastSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_BROADCAST, ...(JSON.parse(raw) as Partial<BroadcastSettings>) } : { ...DEFAULT_BROADCAST };
  } catch {
    return { ...DEFAULT_BROADCAST };
  }
}

export function saveBroadcastSettings(s: BroadcastSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* sin almacenamiento */
  }
}

const dbToGain = (db: number) => Math.pow(10, db / 20);

/** Mezcla en Web Audio; `stream` es la pista de salida que se publica. */
export class BroadcastMixer {
  readonly ctx: AudioContext;
  readonly stream: MediaStream;
  private readonly bus: GainNode;
  private readonly destination: MediaStreamAudioDestinationNode;
  private readonly monitorBus: GainNode;
  private readonly karaokeTap: GainNode;
  private readonly musicGain: GainNode;
  /** Música hacia el monitor local: se corta con la captura de pestaña (esa música ya suena sola y volvería a entrar: eco). */
  private readonly musicMonitor: GainNode;
  private readonly analyser: AnalyserNode;
  private musicAnalyser!: AnalyserNode;
  private readonly buf: Float32Array<ArrayBuffer>;
  private mic: { stream: MediaStream; chain: VoiceChain } | null = null;
  private camera: MediaStream | null = null;
  private music: { stream: MediaStream | null; source: AudioNode; kind: MusicSource } | null = null;
  micMuted = false;

  constructor() {
    const ctx = getSharedAudioContext();
    if (!ctx) throw new Error('Este navegador no admite Web Audio');
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.destination = ctx.createMediaStreamDestination();
    this.monitorBus = ctx.createGain();
    this.karaokeTap = ctx.createGain();
    this.musicGain = ctx.createGain();
    this.musicMonitor = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buf = new Float32Array(this.analyser.fftSize) as Float32Array<ArrayBuffer>;
    // Limitador final: nunca se envía una señal saturada.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.05;
    this.bus.connect(limiter).connect(this.destination);
    limiter.connect(this.analyser);
    this.musicGain.connect(this.bus);
    this.musicAnalyser = ctx.createAnalyser();
    this.musicAnalyser.fftSize = 1024;
    this.musicGain.connect(this.musicAnalyser);
    this.musicGain.connect(this.musicMonitor).connect(this.monitorBus);
    // Los cantantes ya suenan por el PA desde el panel de karaoke: aquí solo entran en la transmisión.
    this.karaokeTap.connect(this.bus);
    this.monitorBus.connect(ctx.destination);
    addKaraokeTap(this.karaokeTap);
    this.stream = this.destination.stream;
  }

  /** Abre el micrófono del animador (procesado como voz hablada). */
  async setMic(deviceId: string, db: number): Promise<void> {
    this.closeMic();
    const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } };
    if (deviceId) audio.deviceId = { exact: deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    const chain = new VoiceChain(this.ctx);
    chain.applyPreset('TALK');
    chain.setGainDb(db);
    chain.setSource(stream);
    chain.output.connect(this.bus);
    this.mic = { stream, chain };
    this.applyMicMute();
  }

  /** Cámara del animador: su pista de vídeo se añade al flujo que se publica (antes de iniciar la transmisión). */
  async setCamera(deviceId: string): Promise<MediaStream> {
    this.closeCamera();
    const video: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
    if (deviceId) video.deviceId = { exact: deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    for (const t of stream.getVideoTracks()) this.stream.addTrack(t);
    this.camera = stream;
    return stream;
  }

  closeCamera(): void {
    if (!this.camera) return;
    for (const t of this.camera.getVideoTracks()) {
      this.stream.removeTrack(t);
      t.stop();
    }
    this.camera = null;
  }

  setMicDb(db: number): void {
    this.mic?.chain.setGainDb(db);
  }

  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
    this.applyMicMute();
  }

  private applyMicMute(): void {
    this.mic?.stream.getAudioTracks().forEach((t) => (t.enabled = !this.micMuted));
  }

  closeMic(): void {
    if (!this.mic) return;
    this.mic.chain.dispose();
    this.mic.stream.getTracks().forEach((t) => t.stop());
    this.mic = null;
  }

  /**
   * Fuente de música. 'device': entrada de audio (mezclador/loopback). 'tab': audio de esta pestaña por captura de
   * pantalla (el navegador pide elegir la pestaña actual y marcar "Compartir audio").
   */
  async setMusic(source: MusicSource, deviceId: string, db: number): Promise<void> {
    this.closeMusic();
    this.musicGain.gain.value = dbToGain(db);
    this.musicMonitor.gain.value = source === 'tab' ? 0 : 1;
    if (source === 'none') return;
    if (source === 'local') {
      const node = localPlayer().audioSource(this.ctx);
      node.disconnect();
      node.connect(this.musicGain);
      this.music = { stream: null, source: node, kind: source };
      return;
    }
    let stream: MediaStream;
    if (source === 'tab') {
      const md = navigator.mediaDevices as MediaDevices & { getDisplayMedia(c: unknown): Promise<MediaStream> };
      stream = await md.getDisplayMedia({ video: true, audio: true, preferCurrentTab: true, selfBrowserSurface: 'include', systemAudio: 'include' });
      stream.getVideoTracks().forEach((t) => t.stop()); // solo interesa el audio
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('La captura no incluyó audio: en el diálogo del navegador marca "Compartir audio de la pestaña".');
      }
    } else {
      const audio: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 } };
      if (deviceId) audio.deviceId = { exact: deviceId };
      stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    }
    const node = this.ctx.createMediaStreamSource(stream);
    node.connect(this.musicGain);
    this.music = { stream, source: node, kind: source };
    stream.getAudioTracks()[0]?.addEventListener('ended', () => this.closeMusic());
  }

  setMusicDb(db: number): void {
    this.musicGain.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.02);
  }

  get musicActive(): boolean {
    if (!this.music) return false;
    return this.music.kind === 'local' || (this.music.stream?.getAudioTracks().some((t) => t.readyState === 'live') ?? false);
  }

  closeMusic(): void {
    if (!this.music) return;
    if (this.music.kind === 'local') localPlayer().releaseSource();
    else this.music.source.disconnect();
    this.music.stream?.getTracks().forEach((t) => t.stop());
    this.music = null;
  }

  setMonitor(enabled: boolean): void {
    this.monitorBus.gain.setTargetAtTime(enabled ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  /** Nivel de la mezcla enviada (0..1, pico). */
  level(): number {
    this.analyser.getFloatTimeDomainData(this.buf);
    let peak = 0;
    for (const v of this.buf) peak = Math.max(peak, Math.abs(v));
    return Math.min(1, peak);
  }

  micLevel(): number {
    return this.mic?.chain.level() ?? 0;
  }

  /** Nivel de la música que entra en la mezcla (0..1): sirve para detectar una captura muda (p. ej. Spotify protegido). */
  musicLevel(): number {
    this.musicAnalyser.getFloatTimeDomainData(this.buf);
    let peak = 0;
    for (const v of this.buf) peak = Math.max(peak, Math.abs(v));
    return Math.min(1, peak);
  }

  get musicKind(): MusicSource {
    return this.music?.kind ?? 'none';
  }

  get cameraOn(): boolean {
    return this.camera !== null;
  }

  dispose(): void {
    this.closeMic();
    this.closeMusic();
    this.closeCamera();
    removeKaraokeTap(this.karaokeTap);
    this.karaokeTap.disconnect();
    this.musicGain.disconnect();
    this.monitorBus.disconnect();
    this.bus.disconnect();
    this.analyser.disconnect();
    this.stream.getTracks().forEach((t) => t.stop());
  }
}
