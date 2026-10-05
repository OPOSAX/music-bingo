/**
 * Cadena de voz para el micrófono del karaoke en el panel del anfitrión (sin AEC ni worklet):
 * paso alto → EQ de 3 bandas → compresor → limitador → ganancia. El teléfono llega con poco nivel
 * (Opus mono, lejos de la boca) y sin procesar se pierde bajo la música; aquí se le da presencia y
 * nivel estable, y el limitador evita que el PA se sature.
 */

import type { AudioProfile } from '../protocol.js';
import { CompressorProcessor, Eq3Processor, GainProcessor, HighPassProcessor, LimiterProcessor } from './processors.js';

export interface VoicePreset {
  hpfHz: number;
  /** graves (200 Hz), presencia (2,5 kHz), brillo (8 kHz) en dB */
  eq: [number, number, number];
  compThreshold: number;
  compRatio: number;
}

export const VOICE_PRESETS: Record<AudioProfile, VoicePreset> = {
  // Cantar: cuerpo de la voz intacto, presencia y brillo para cortar la mezcla.
  SING: { hpfHz: 90, eq: [-2, 4, 3], compThreshold: -24, compRatio: 4 },
  // Hablar: más recorte de graves y compresión firme para que se entienda.
  TALK: { hpfHz: 130, eq: [-5, 5, 2], compThreshold: -22, compRatio: 5 },
};

export class VoiceChain {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly hpf: HighPassProcessor;
  readonly eq: Eq3Processor;
  readonly compressor: CompressorProcessor;
  readonly limiter: LimiterProcessor;
  readonly gain: GainProcessor;
  private readonly analyser: AnalyserNode;
  private readonly buf: Float32Array<ArrayBuffer>;
  private source: AudioNode | null = null;

  constructor(readonly ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.hpf = new HighPassProcessor(ctx);
    this.eq = new Eq3Processor(ctx);
    this.compressor = new CompressorProcessor(ctx);
    this.limiter = new LimiterProcessor(ctx, -1);
    this.gain = new GainProcessor(ctx);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buf = new Float32Array(this.analyser.fftSize) as Float32Array<ArrayBuffer>;
    this.input.connect(this.hpf.input);
    this.hpf.output.connect(this.eq.input);
    // La ganancia va antes del compresor: así el compresor trabaja con señal suficiente y el limitador cierra la cadena.
    this.eq.output.connect(this.gain.input);
    this.gain.output.connect(this.compressor.input);
    this.compressor.output.connect(this.limiter.input);
    this.limiter.output.connect(this.output);
    this.output.connect(this.analyser);
  }

  setSource(source: MediaStream | AudioNode): void {
    this.source?.disconnect();
    this.source = source instanceof AudioNode ? source : this.ctx.createMediaStreamSource(source);
    this.source.connect(this.input);
  }

  applyPreset(profile: AudioProfile): void {
    const p = VOICE_PRESETS[profile];
    this.hpf.filter.frequency.value = p.hpfHz;
    this.eq.set(...p.eq);
    this.compressor.node.threshold.value = p.compThreshold;
    this.compressor.node.ratio.value = p.compRatio;
  }

  /** Ganancia de la voz en dB (positiva: el teléfono suele llegar muy bajo). */
  setGainDb(db: number): void {
    this.gain.setDb(db);
  }

  /** Todo en bypass salvo la ganancia (para comparar). */
  setProcessing(enabled: boolean): void {
    this.hpf.setEnabled(enabled);
    this.eq.setEnabled(enabled);
    this.compressor.setEnabled(enabled);
    this.limiter.setEnabled(enabled);
  }

  /** Nivel de salida 0..1 (pico) para el medidor. */
  level(): number {
    this.analyser.getFloatTimeDomainData(this.buf);
    let peak = 0;
    for (const v of this.buf) peak = Math.max(peak, Math.abs(v));
    return Math.min(1, peak);
  }

  dispose(): void {
    this.source?.disconnect();
    for (const p of [this.hpf, this.eq, this.compressor, this.limiter, this.gain]) p.dispose();
    this.input.disconnect();
    this.output.disconnect();
    this.analyser.disconnect();
  }
}

export interface MixSettings {
  voiceDb: number;
  preset: AudioProfile;
  processing: boolean;
  /** Volumen de la música mientras alguien canta (0..100). */
  musicWhileSinging: number;
  /** Bajar la música automáticamente al dar paso a un micrófono. */
  autoDuck: boolean;
}

export const DEFAULT_MIX: MixSettings = { voiceDb: 12, preset: 'SING', processing: true, musicWhileSinging: 55, autoDuck: true };

const MIX_KEY = 'concert:mix';

export function loadMix(): MixSettings {
  try {
    const raw = globalThis.localStorage?.getItem(MIX_KEY);
    return raw ? { ...DEFAULT_MIX, ...(JSON.parse(raw) as Partial<MixSettings>) } : { ...DEFAULT_MIX };
  } catch {
    return { ...DEFAULT_MIX };
  }
}

export function saveMix(mix: MixSettings): void {
  try {
    globalThis.localStorage?.setItem(MIX_KEY, JSON.stringify(mix));
  } catch {
    /* almacenamiento no disponible */
  }
}
