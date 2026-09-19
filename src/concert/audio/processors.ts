/** Procesadores de audio modulares (Web Audio) para el ConcertAudioEngine. */

export interface AudioProcessor {
  readonly id: string;
  readonly input: AudioNode;
  readonly output: AudioNode;
  enabled: boolean;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

/** Procesador con bypass: cuando está desactivado, la señal pasa por un GainNode de unidad. */
abstract class SwitchableProcessor implements AudioProcessor {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly wet: GainNode;
  private readonly dry: GainNode;
  enabled = true;

  protected constructor(
    readonly ctx: BaseAudioContext,
    readonly id: string,
    first: AudioNode,
    last: AudioNode,
  ) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.wet = ctx.createGain();
    this.dry = ctx.createGain();
    this.dry.gain.value = 0;
    this.input.connect(first);
    last.connect(this.wet).connect(this.output);
    this.input.connect(this.dry).connect(this.output);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    const t = this.ctx.currentTime;
    this.wet.gain.setTargetAtTime(enabled ? 1 : 0, t, 0.01);
    this.dry.gain.setTargetAtTime(enabled ? 0 : 1, t, 0.01);
  }

  dispose(): void {
    this.input.disconnect();
    this.output.disconnect();
  }
}

export class HighPassProcessor extends SwitchableProcessor {
  readonly filter: BiquadFilterNode;
  constructor(ctx: BaseAudioContext, frequency = 90) {
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = frequency;
    f.Q.value = 0.7;
    super(ctx, 'highpass', f, f);
    this.filter = f;
  }
}

/** EQ de tres bandas: graves (shelf), medios (peaking) y agudos (shelf). */
export class Eq3Processor extends SwitchableProcessor {
  readonly low: BiquadFilterNode;
  readonly mid: BiquadFilterNode;
  readonly high: BiquadFilterNode;
  constructor(ctx: BaseAudioContext) {
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 200;
    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 2500;
    mid.Q.value = 1;
    const high = ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 8000;
    low.connect(mid).connect(high);
    super(ctx, 'eq', low, high);
    this.low = low;
    this.mid = mid;
    this.high = high;
  }
  set(lowDb: number, midDb: number, highDb: number): void {
    this.low.gain.value = lowDb;
    this.mid.gain.value = midDb;
    this.high.gain.value = highDb;
  }
}

export class CompressorProcessor extends SwitchableProcessor {
  readonly node: DynamicsCompressorNode;
  constructor(ctx: BaseAudioContext) {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = -18;
    c.knee.value = 12;
    c.ratio.value = 3;
    c.attack.value = 0.005;
    c.release.value = 0.15;
    super(ctx, 'compressor', c, c);
    this.node = c;
  }
}

/** Limitador: compresor de relación alta y ataque mínimo, seguido de un techo por ganancia. */
export class LimiterProcessor extends SwitchableProcessor {
  readonly node: DynamicsCompressorNode;
  constructor(ctx: BaseAudioContext, ceilingDb = -1) {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = ceilingDb - 2;
    c.knee.value = 0;
    c.ratio.value = 20;
    c.attack.value = 0.001;
    c.release.value = 0.05;
    super(ctx, 'limiter', c, c);
    this.node = c;
  }
}

export class GainProcessor extends SwitchableProcessor {
  readonly node: GainNode;
  constructor(ctx: BaseAudioContext, gain = 1) {
    const g = ctx.createGain();
    g.gain.value = gain;
    super(ctx, 'gain', g, g);
    this.node = g;
  }
  setDb(dbValue: number): void {
    this.node.gain.setTargetAtTime(Math.pow(10, dbValue / 20), this.ctx.currentTime, 0.02);
  }
}
