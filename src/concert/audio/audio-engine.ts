/**
 * ConcertAudioEngine: procesa en el navegador del DJ (o en un nodo audio-engine) los micrófonos
 * del público que llegan por WebRTC y los entrega a la salida elegida (interfaz USB → mixer).
 *
 * Cadena por micrófono: HPF → AEC por referencia (worklet) → compuerta/NS → EQ → compresor → limitador → ganancia.
 * Master: suma → limitador → salida. La MUSIC_REFERENCE alimenta la segunda entrada del worklet.
 */

import type { AudioProfile, ConnectionQuality, NoiseReduction } from '../protocol.js';
import type { AecMetrics } from './dsp.js';
import { BrowserOutputProvider, type AudioOutputProvider } from './output-provider.js';
import { CompressorProcessor, Eq3Processor, GainProcessor, HighPassProcessor, LimiterProcessor, type AudioProcessor } from './processors.js';
import { NullReferenceProvider, type ReferenceAudioProvider } from './reference-provider.js';

/** Modo técnico A/B: qué etapas quedan activas. */
export type TechnicalMode = 'RAW' | 'AEC_ONLY' | 'AEC_NS' | 'FINAL';
export const TECHNICAL_MODES: readonly TechnicalMode[] = ['RAW', 'AEC_ONLY', 'AEC_NS', 'FINAL'];

export type RecordingTap = 'rawMic' | 'musicReference' | 'postAEC' | 'finalOutput';

export interface EngineOptions {
  /** URL del módulo worklet compilado (public/js/concert/audio/worklet.js). */
  workletUrl: string;
  profile?: AudioProfile;
  noiseReduction?: NoiseReduction;
  aecEnabled?: boolean;
  reference?: ReferenceAudioProvider;
  output?: AudioOutputProvider;
  sampleRate?: number;
}

/** Mensaje de métricas que emite el worklet cada 32 bloques. */
interface WorkletMetrics {
  type: 'metrics';
  referenceDelayMs: number;
  referenceCorrelation: number;
  erleDb: number;
  doubleTalk: boolean;
  inputRms: number;
  outputRms: number;
}

export interface ChannelMetrics extends Pick<AecMetrics, 'referenceDelayMs' | 'referenceCorrelation' | 'erleDb' | 'doubleTalk' | 'aecReductionDb'> {
  slotId: string;
  inputRms: number;
  outputRms: number;
  /** Nivel de entrada/salida en dBFS (aprox.). */
  inputDb: number;
  outputDb: number;
}

export const NOISE_GATE_STRENGTH: Record<NoiseReduction, number> = { OFF: 0, LIGHT: 0.3, MEDIUM: 0.6, STRONG: 0.9 };

interface Profile {
  hpfHz: number;
  eq: [number, number, number];
  compThreshold: number;
  compRatio: number;
}

const PROFILES: Record<AudioProfile, Profile> = {
  // Cantar: respeta graves de voz y dinámica, brillo suave para cortar la mezcla.
  SING: { hpfHz: 80, eq: [-1.5, 1, 2.5], compThreshold: -20, compRatio: 3 },
  // Hablar: más recorte de graves, presencia en medios, compresión más firme.
  TALK: { hpfHz: 120, eq: [-4, 3, 1], compThreshold: -18, compRatio: 4 },
};

function toDb(rmsValue: number): number {
  return rmsValue > 1e-6 ? 20 * Math.log10(rmsValue) : -120;
}

/** Cadena de procesado de un micrófono (un slot). */
export class MicChannel {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly hpf: HighPassProcessor;
  readonly aec: AudioWorkletNode;
  readonly eq: Eq3Processor;
  readonly compressor: CompressorProcessor;
  readonly limiter: LimiterProcessor;
  readonly gain: GainProcessor;
  private readonly aecBypass: GainNode;
  private readonly aecWet: GainNode;
  private readonly postAecTap: GainNode;
  private last: ChannelMetrics;
  private source: AudioNode | null = null;
  private aecOn = true;
  private gateOn = true;

  constructor(
    readonly ctx: AudioContext,
    readonly slotId: string,
    referenceBus: AudioNode,
  ) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.hpf = new HighPassProcessor(ctx);
    this.aec = new AudioWorkletNode(ctx, 'crowd-mic-aec', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
    this.aecBypass = ctx.createGain();
    this.aecWet = ctx.createGain();
    this.postAecTap = ctx.createGain();
    this.eq = new Eq3Processor(ctx);
    this.compressor = new CompressorProcessor(ctx);
    this.limiter = new LimiterProcessor(ctx);
    this.gain = new GainProcessor(ctx);
    this.aecBypass.gain.value = 0;

    this.input.connect(this.hpf.input);
    this.hpf.output.connect(this.aec, 0, 0);
    referenceBus.connect(this.aec, 0, 1);
    this.aec.connect(this.aecWet).connect(this.postAecTap);
    this.hpf.output.connect(this.aecBypass).connect(this.postAecTap);
    this.postAecTap.connect(this.eq.input);
    this.eq.output.connect(this.compressor.input);
    this.compressor.output.connect(this.limiter.input);
    this.limiter.output.connect(this.gain.input);
    this.gain.output.connect(this.output);

    this.last = { slotId, referenceDelayMs: 0, referenceCorrelation: 0, erleDb: 0, aecReductionDb: 0, doubleTalk: false, inputRms: 0, outputRms: 0, inputDb: -120, outputDb: -120 };
    this.aec.port.onmessage = (ev: MessageEvent<Partial<WorkletMetrics>>) => {
      if (ev.data.type !== 'metrics') return;
      const m = ev.data;
      const inputRms = m.inputRms ?? 0;
      const outputRms = m.outputRms ?? 0;
      this.last = {
        slotId,
        referenceDelayMs: m.referenceDelayMs ?? 0,
        referenceCorrelation: m.referenceCorrelation ?? 0,
        erleDb: m.erleDb ?? 0,
        aecReductionDb: Math.max(0, toDb(inputRms) - toDb(outputRms)),
        doubleTalk: m.doubleTalk ?? false,
        inputRms,
        outputRms,
        inputDb: toDb(inputRms),
        outputDb: toDb(outputRms),
      };
    };
  }

  /** Nodo tras el AEC (antes de EQ/dinámica), para grabaciones de prueba. */
  get postAec(): AudioNode {
    return this.postAecTap;
  }

  get processors(): AudioProcessor[] {
    return [this.hpf, this.eq, this.compressor, this.limiter, this.gain];
  }

  /** Conecta la fuente: MediaStream del consumer WebRTC o cualquier AudioNode. */
  setSource(source: MediaStream | AudioNode): void {
    this.source?.disconnect();
    this.source = source instanceof AudioNode ? source : this.ctx.createMediaStreamSource(source);
    this.source.connect(this.input);
  }

  setAec(enabled: boolean): void {
    this.aecOn = enabled;
    this.aec.port.postMessage({ type: 'aec', enabled });
    const t = this.ctx.currentTime;
    this.aecWet.gain.setTargetAtTime(enabled ? 1 : 0, t, 0.01);
    this.aecBypass.gain.setTargetAtTime(enabled ? 0 : 1, t, 0.01);
  }

  setNoiseReduction(level: NoiseReduction): void {
    this.gateOn = level !== 'OFF';
    this.aec.port.postMessage({ type: 'gate', value: NOISE_GATE_STRENGTH[level] });
    this.aec.port.postMessage({ type: 'gateThreshold', value: level === 'STRONG' ? 0.02 : level === 'MEDIUM' ? 0.012 : 0.008 });
  }

  setReferenceDelay(ms: number): void {
    this.aec.port.postMessage({ type: 'delay', delayMs: ms });
  }

  resetAec(): void {
    this.aec.port.postMessage({ type: 'reset' });
  }

  applyProfile(profile: AudioProfile): void {
    const p = PROFILES[profile];
    this.hpf.filter.frequency.value = p.hpfHz;
    this.eq.set(...p.eq);
    this.compressor.node.threshold.value = p.compThreshold;
    this.compressor.node.ratio.value = p.compRatio;
  }

  /** Modo técnico: RAW (todo en bypass), AEC_ONLY, AEC_NS (AEC + compuerta), FINAL (cadena completa). */
  applyMode(mode: TechnicalMode, aecWanted: boolean, nsWanted: NoiseReduction): void {
    const aec = mode !== 'RAW' && aecWanted;
    const ns = (mode === 'AEC_NS' || mode === 'FINAL') && nsWanted !== 'OFF';
    const dynamics = mode === 'FINAL';
    this.setAec(aec);
    this.aec.port.postMessage({ type: 'bypassGate', enabled: !ns });
    this.hpf.setEnabled(dynamics);
    this.eq.setEnabled(dynamics);
    this.compressor.setEnabled(dynamics);
    this.limiter.setEnabled(dynamics);
    this.gain.setEnabled(dynamics);
  }

  metrics(): ChannelMetrics {
    return this.last;
  }

  get aecEnabled(): boolean {
    return this.aecOn;
  }

  get gateEnabled(): boolean {
    return this.gateOn;
  }

  dispose(): void {
    this.source?.disconnect();
    this.aec.port.onmessage = null;
    this.aec.disconnect();
    for (const p of this.processors) p.dispose();
    this.input.disconnect();
    this.output.disconnect();
  }
}

export class ConcertAudioEngine {
  ctx: AudioContext | null = null;
  readonly channels = new Map<string, MicChannel>();
  private referenceBus: GainNode | null = null;
  private referenceMonitor: GainNode | null = null;
  private master: GainNode | null = null;
  private masterLimiter: LimiterProcessor | null = null;
  private reference: ReferenceAudioProvider;
  private output: AudioOutputProvider;
  profile: AudioProfile;
  noiseReduction: NoiseReduction;
  aecEnabled: boolean;
  mode: TechnicalMode = 'FINAL';
  referenceDelayMs: number | null = null;
  private recorders: Partial<Record<RecordingTap, { recorder: MediaRecorder; chunks: Blob[] }>> = {};

  constructor(private readonly options: EngineOptions) {
    this.profile = options.profile ?? 'SING';
    this.noiseReduction = options.noiseReduction ?? 'LIGHT';
    this.aecEnabled = options.aecEnabled ?? true;
    this.reference = options.reference ?? new NullReferenceProvider();
    this.output = options.output ?? new BrowserOutputProvider();
  }

  get running(): boolean {
    return this.ctx !== null;
  }

  get referenceLabel(): string {
    return this.reference.label;
  }

  get referenceHasAudio(): boolean {
    return this.reference.hasAudio;
  }

  async start(): Promise<void> {
    if (this.ctx) return;
    const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: this.options.sampleRate ?? 48000 });
    await ctx.audioWorklet.addModule(this.options.workletUrl);
    this.ctx = ctx;
    this.referenceBus = ctx.createGain();
    this.referenceMonitor = ctx.createGain();
    this.referenceMonitor.gain.value = 0; // la referencia no se reenvía a la salida (ya suena por el PA)
    this.master = ctx.createGain();
    this.masterLimiter = new LimiterProcessor(ctx, -1);
    this.master.connect(this.masterLimiter.input);
    this.referenceBus.connect(this.referenceMonitor).connect(this.master);
    await this.output.connect(ctx, this.masterLimiter.output);
    await this.startReference();
    if (ctx.state === 'suspended') await ctx.resume();
  }

  private async startReference(): Promise<void> {
    if (!this.ctx || !this.referenceBus) return;
    const node = await this.reference.start(this.ctx);
    node?.connect(this.referenceBus);
  }

  async setReference(provider: ReferenceAudioProvider): Promise<void> {
    this.reference.stop();
    this.reference = provider;
    if (this.ctx) {
      await this.startReference();
      for (const ch of this.channels.values()) ch.resetAec();
    }
  }

  async setOutput(provider: AudioOutputProvider): Promise<void> {
    this.output.disconnect();
    this.output = provider;
    if (this.ctx && this.masterLimiter) await this.output.connect(this.ctx, this.masterLimiter.output);
  }

  referenceMetadata() {
    return this.reference.metadata();
  }

  /** Añade el micrófono de un slot (stream del consumer WebRTC del DJ). */
  addMic(slotId: string, source: MediaStream | AudioNode): MicChannel {
    if (!this.ctx || !this.referenceBus || !this.master) throw new Error('El motor no está iniciado');
    this.removeMic(slotId);
    const ch = new MicChannel(this.ctx, slotId, this.referenceBus);
    ch.setSource(source);
    ch.applyProfile(this.profile);
    ch.setNoiseReduction(this.noiseReduction);
    ch.applyMode(this.mode, this.aecEnabled, this.noiseReduction);
    if (this.referenceDelayMs !== null) ch.setReferenceDelay(this.referenceDelayMs);
    ch.output.connect(this.master);
    this.channels.set(slotId, ch);
    return ch;
  }

  removeMic(slotId: string): void {
    const ch = this.channels.get(slotId);
    if (!ch) return;
    ch.dispose();
    this.channels.delete(slotId);
  }

  setProfile(profile: AudioProfile): void {
    this.profile = profile;
    for (const ch of this.channels.values()) ch.applyProfile(profile);
  }

  setNoiseReduction(level: NoiseReduction): void {
    this.noiseReduction = level;
    for (const ch of this.channels.values()) {
      ch.setNoiseReduction(level);
      ch.applyMode(this.mode, this.aecEnabled, level);
    }
  }

  setAec(enabled: boolean): void {
    this.aecEnabled = enabled;
    for (const ch of this.channels.values()) ch.applyMode(this.mode, enabled, this.noiseReduction);
  }

  setMode(mode: TechnicalMode): void {
    this.mode = mode;
    for (const ch of this.channels.values()) ch.applyMode(mode, this.aecEnabled, this.noiseReduction);
  }

  /** Fija el retardo de referencia manualmente (null = estimación automática por correlación). */
  setReferenceDelay(ms: number | null): void {
    this.referenceDelayMs = ms;
    for (const ch of this.channels.values()) {
      if (ms === null) ch.resetAec();
      else ch.setReferenceDelay(ms);
    }
  }

  setMasterGainDb(dbValue: number): void {
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(Math.pow(10, dbValue / 20), this.ctx.currentTime, 0.02);
  }

  metrics(): ChannelMetrics[] {
    return [...this.channels.values()].map((ch) => ch.metrics());
  }

  /** Resumen de salud del AEC de un canal: GOOD si cancela bien, BAD si no encuentra referencia. */
  static aecQuality(m: ChannelMetrics, hasReference: boolean): ConnectionQuality {
    if (!hasReference) return 'UNKNOWN';
    if (m.referenceCorrelation < 0.1) return 'BAD';
    if (m.erleDb >= 10) return 'GOOD';
    if (m.erleDb >= 4) return 'FAIR';
    return 'BAD';
  }

  /* ---------------- Grabación local de prueba ---------------- */

  private tapNode(tap: RecordingTap, slotId: string): AudioNode | null {
    const ch = this.channels.get(slotId);
    switch (tap) {
      case 'rawMic':
        return ch?.input ?? null;
      case 'musicReference':
        return this.referenceBus;
      case 'postAEC':
        return ch?.postAec ?? null;
      case 'finalOutput':
        return this.masterLimiter?.output ?? null;
    }
  }

  /** Graba las cuatro señales (rawMic, musicReference, postAEC, finalOutput) del slot indicado. */
  startRecording(slotId: string, taps: RecordingTap[] = ['rawMic', 'musicReference', 'postAEC', 'finalOutput']): void {
    if (!this.ctx || typeof MediaRecorder === 'undefined') throw new Error('Grabación no disponible');
    this.stopRecordingSync();
    for (const tap of taps) {
      const node = this.tapNode(tap, slotId);
      if (!node) continue;
      const dest = this.ctx.createMediaStreamDestination();
      node.connect(dest);
      const recorder = new MediaRecorder(dest.stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size) chunks.push(ev.data);
      };
      recorder.start(1000);
      this.recorders[tap] = { recorder, chunks };
    }
  }

  get recording(): boolean {
    return Object.keys(this.recorders).length > 0;
  }

  async stopRecording(): Promise<Partial<Record<RecordingTap, Blob>>> {
    const out: Partial<Record<RecordingTap, Blob>> = {};
    const entries = Object.entries(this.recorders) as [RecordingTap, { recorder: MediaRecorder; chunks: Blob[] }][];
    this.recorders = {};
    await Promise.all(
      entries.map(
        ([tap, { recorder, chunks }]) =>
          new Promise<void>((resolve) => {
            recorder.onstop = () => {
              out[tap] = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
              resolve();
            };
            if (recorder.state === 'inactive') recorder.onstop(new Event('stop'));
            else recorder.stop();
          }),
      ),
    );
    return out;
  }

  private stopRecordingSync(): void {
    for (const entry of Object.values(this.recorders)) if (entry.recorder.state !== 'inactive') entry.recorder.stop();
    this.recorders = {};
  }

  async stop(): Promise<void> {
    this.stopRecordingSync();
    for (const id of [...this.channels.keys()]) this.removeMic(id);
    this.reference.stop();
    this.output.disconnect();
    this.masterLimiter?.dispose();
    this.master?.disconnect();
    this.referenceBus?.disconnect();
    const ctx = this.ctx;
    this.ctx = null;
    this.referenceBus = null;
    this.master = null;
    this.masterLimiter = null;
    if (ctx) await ctx.close();
  }
}
