/**
 * DSP puro (sin Web Audio) para el cancelador por referencia: se ejecuta igual en un
 * AudioWorklet, en el hilo principal o en Node para las pruebas.
 */

/** Potencia media (RMS) de un bloque. */
export function rms(block: Float32Array): number {
  let acc = 0;
  for (let i = 0; i < block.length; i++) acc += (block[i] as number) * (block[i] as number);
  return Math.sqrt(acc / Math.max(1, block.length));
}

export function db(ratio: number): number {
  return 20 * Math.log10(Math.max(1e-12, ratio));
}

/**
 * Estima el retardo (en muestras) con el que la referencia aparece en el micrófono,
 * buscando el máximo de correlación cruzada normalizada en [0, maxLag].
 * Devuelve también la correlación (0..1) como medida de confianza.
 */
export function estimateDelay(mic: Float32Array, reference: Float32Array, maxLag: number, minLag = 0): { lag: number; correlation: number } {
  const n = Math.min(mic.length, reference.length);
  let bestLag = minLag;
  let best = -Infinity;
  const refEnergy = energy(reference, 0, n - maxLag);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let dot = 0;
    let micEnergy = 0;
    const len = n - maxLag;
    for (let i = 0; i < len; i++) {
      const m = mic[i + lag] as number;
      dot += m * (reference[i] as number);
      micEnergy += m * m;
    }
    const corr = dot / Math.sqrt(Math.max(1e-12, micEnergy * refEnergy));
    if (corr > best) {
      best = corr;
      bestLag = lag;
    }
  }
  return { lag: bestLag, correlation: Math.max(0, Math.min(1, best)) };
}

function energy(x: Float32Array, from: number, to: number): number {
  let acc = 0;
  for (let i = from; i < to; i++) acc += (x[i] as number) * (x[i] as number);
  return acc;
}

export interface NlmsOptions {
  /** Longitud del filtro adaptativo en muestras (cubre la cola de reverberación tras alinear). */
  taps: number;
  /** Paso de adaptación (0 < mu < 2). */
  mu?: number;
  /** Regularización para evitar divisiones por cero. */
  epsilon?: number;
  /** Tamaño de bloque (muestras) para decidir si el filtro de fondo mejora al de primer plano. */
  blockSize?: number;
}

/**
 * Cancelador adaptativo NLMS de dos filtros (primer plano / fondo), el esquema clásico
 * robusto al doble habla: el filtro de fondo adapta siempre; el de primer plano, que es el
 * que produce la salida, solo se actualiza cuando el de fondo demuestra cancelar mejor.
 * Mientras el cantante canta, el filtro de fondo se degrada pero el de primer plano no.
 */
export class NlmsCanceller {
  private readonly wFg: Float32Array;
  private readonly wBg: Float32Array;
  private readonly x: Float32Array;
  private pos = 0;
  private readonly mu: number;
  private readonly eps: number;
  private readonly blockSize: number;
  private blockCount = 0;
  private pdBlock = 0;
  private peFgBlock = 0;
  private peBgBlock = 0;
  /** Potencias suavizadas para métricas ERLE. */
  private inPower = 1e-6;
  private outPower = 1e-6;
  /** true si en el último bloque se detectó voz cercana (doble habla) y la adaptación quedó casi congelada. */
  frozen = false;
  /** El filtro de primer plano ha llegado a cancelar al menos ~5 dB alguna vez. */
  private converged = false;
  private muScale = 1;
  private frozenBlocks = 0;

  constructor(options: NlmsOptions) {
    this.wFg = new Float32Array(options.taps);
    this.wBg = new Float32Array(options.taps);
    this.x = new Float32Array(options.taps);
    this.mu = options.mu ?? 0.5;
    this.eps = options.epsilon ?? 1e-4;
    this.blockSize = options.blockSize ?? 256;
  }

  get taps(): number {
    return this.wFg.length;
  }

  reset(): void {
    this.wFg.fill(0);
    this.wBg.fill(0);
    this.x.fill(0);
    this.inPower = this.outPower = 1e-6;
    this.blockCount = this.pdBlock = this.peFgBlock = this.peBgBlock = 0;
    this.converged = false;
    this.muScale = 1;
    this.frozenBlocks = 0;
  }

  /** Procesa un bloque: mic (near-end) y ref (far-end alineada). Devuelve la voz estimada. */
  process(mic: Float32Array, ref: Float32Array, out: Float32Array = new Float32Array(mic.length)): Float32Array {
    const taps = this.wFg.length;
    for (let n = 0; n < mic.length; n++) {
      this.pos = (this.pos - 1 + taps) % taps;
      this.x[this.pos] = ref[n] as number;
      let yFg = 0;
      let yBg = 0;
      let power = this.eps;
      for (let k = 0; k < taps; k++) {
        const xi = this.x[(this.pos + k) % taps] as number;
        yFg += (this.wFg[k] as number) * xi;
        yBg += (this.wBg[k] as number) * xi;
        power += xi * xi;
      }
      const d = mic[n] as number;
      const eFg = d - yFg;
      const eBg = d - yBg;
      out[n] = eFg;
      const step = (this.mu * this.muScale * eBg) / power;
      for (let k = 0; k < taps; k++) this.wBg[k] = (this.wBg[k] as number) + step * (this.x[(this.pos + k) % taps] as number);

      this.pdBlock += d * d;
      this.peFgBlock += eFg * eFg;
      this.peBgBlock += eBg * eBg;
      this.inPower = 0.999 * this.inPower + 0.001 * d * d;
      this.outPower = 0.999 * this.outPower + 0.001 * eFg * eFg;
      if (++this.blockCount >= this.blockSize) this.endBlock();
    }
    return out;
  }

  private endBlock(): void {
    const pd = this.pdBlock + 1e-9;
    if (this.peFgBlock < 0.3 * pd) this.converged = true;
    // Doble habla: el primer plano ya cancelaba y ahora deja mucho residuo → hay voz cercana.
    const nearEnd = this.converged && this.peFgBlock > 0.3 * pd;
    if (nearEnd) {
      this.frozenBlocks++;
      // Casi congelado; si dura mucho (cambio del camino acústico) se permite readaptar despacio.
      this.muScale = this.frozenBlocks > 200 ? 0.2 : 0.02;
      if (this.peBgBlock > 2 * this.peFgBlock) this.wBg.set(this.wFg); // el fondo se corrompió: se vuelve a sembrar
    } else {
      this.frozenBlocks = 0;
      this.muScale = 1;
      if (this.peBgBlock < 0.7 * this.peFgBlock) this.wFg.set(this.wBg);
      else if (this.peBgBlock > 4 * this.peFgBlock) this.wBg.set(this.wFg);
    }
    this.frozen = nearEnd;
    this.blockCount = this.pdBlock = this.peFgBlock = this.peBgBlock = 0;
  }

  /** Echo Return Loss Enhancement: cuánto se ha reducido la señal (dB). */
  get erleDb(): number {
    return db(Math.sqrt(this.inPower / Math.max(1e-12, this.outPower)));
  }
}

export interface AecMetrics {
  referenceDelayMs: number;
  referenceCorrelation: number;
  /** Echo Return Loss: relación entre la referencia y lo que de ella llega al micrófono (dB). */
  erlDb: number;
  /** Echo Return Loss Enhancement conseguido por el cancelador (dB). */
  erleDb: number;
  /** Reducción total de la música (dB). */
  aecReductionDb: number;
  doubleTalk: boolean;
}

/** Mide la reducción de una señal conocida comparando su energía antes y después del cancelador. */
export function reductionDb(before: Float32Array, after: Float32Array): number {
  return db(rms(before) / Math.max(1e-12, rms(after)));
}

/**
 * Cancelador completo por referencia: estima el retardo, alinea y aplica NLMS.
 * Trabaja con bloques del tamaño que le pase el llamante (128 muestras en AudioWorklet).
 */
export class ReferenceEchoCancellerCore {
  private readonly canceller: NlmsCanceller;
  private readonly refHistory: Float32Array;
  private refWrite = 0;
  private delaySamples: number;
  private readonly searchMin: number;
  private readonly searchMax: number;
  private micWindow: Float32Array;
  private refWindow: Float32Array;
  private windowFill = 0;
  private locked = false;
  correlation = 0;
  private readonly sampleRate: number;

  constructor(options: { sampleRate: number; taps?: number; maxDelayMs?: number; minDelayMs?: number; analysisMs?: number; mu?: number }) {
    this.sampleRate = options.sampleRate;
    this.canceller = new NlmsCanceller({ taps: options.taps ?? 256, mu: options.mu ?? 0.5 });
    this.searchMax = Math.round(((options.maxDelayMs ?? 1000) / 1000) * options.sampleRate);
    this.searchMin = Math.round(((options.minDelayMs ?? 0) / 1000) * options.sampleRate);
    const analysis = Math.round(((options.analysisMs ?? 400) / 1000) * options.sampleRate);
    this.refHistory = new Float32Array(this.searchMax + analysis + this.canceller.taps + 1024);
    this.micWindow = new Float32Array(analysis);
    this.refWindow = new Float32Array(analysis + this.searchMax);
    this.delaySamples = this.searchMin;
  }

  get delayMs(): number {
    return (this.delaySamples / this.sampleRate) * 1000;
  }

  get erleDb(): number {
    return this.canceller.erleDb;
  }

  get doubleTalk(): boolean {
    return this.canceller.frozen;
  }

  /** Fija un retardo conocido (por ejemplo medido manualmente) y detiene la búsqueda. */
  setDelayMs(ms: number): void {
    this.delaySamples = Math.max(0, Math.round((ms / 1000) * this.sampleRate));
    this.locked = true;
    this.canceller.reset();
  }

  process(mic: Float32Array, ref: Float32Array, out?: Float32Array): Float32Array {
    // 1. Guardar la referencia en el historial
    for (let i = 0; i < ref.length; i++) {
      this.refHistory[this.refWrite] = ref[i] as number;
      this.refWrite = (this.refWrite + 1) % this.refHistory.length;
    }
    // 2. Acumular ventanas para la estimación del retardo
    if (!this.locked) this.accumulate(mic, ref);
    // 3. Referencia alineada: la muestra de referencia de hace `delay` muestras
    const aligned = new Float32Array(mic.length);
    const len = this.refHistory.length;
    for (let i = 0; i < mic.length; i++) {
      const idx = (this.refWrite - mic.length + i - this.delaySamples + 2 * len) % len;
      aligned[i] = this.refHistory[idx] as number;
    }
    return this.canceller.process(mic, aligned, out);
  }

  private accumulate(mic: Float32Array, ref: Float32Array): void {
    const n = this.micWindow.length;
    for (let i = 0; i < mic.length; i++) {
      if (this.windowFill < n) {
        this.micWindow[this.windowFill] = mic[i] as number;
      }
      this.windowFill++;
    }
    if (this.windowFill >= n) {
      // La ventana del micrófono se llenó `extra` muestras antes del final del bloque:
      // la referencia se toma hasta ese mismo instante para que ambas ventanas coincidan.
      const extra = this.windowFill - n;
      const total = this.refWindow.length;
      const len = this.refHistory.length;
      for (let i = 0; i < total; i++) this.refWindow[i] = this.refHistory[(this.refWrite - extra - total + i + 2 * len) % len] as number;
      const { lag, correlation } = this.searchLag();
      if (correlation > 0.3 && (correlation > this.correlation * 0.8 || Math.abs(lag - this.delaySamples) > 4)) {
        if (lag !== this.delaySamples) this.canceller.reset();
        this.delaySamples = lag;
      }
      this.correlation = correlation;
      this.windowFill = 0;
    }
  }

  /** Búsqueda del retardo: mic[t] ≈ ref[t - lag]; refWindow tiene searchMax muestras extra por delante. */
  private searchLag(): { lag: number; correlation: number } {
    const n = this.micWindow.length;
    let bestLag = this.searchMin;
    let best = -Infinity;
    let micEnergy = 0;
    for (let i = 0; i < n; i++) micEnergy += (this.micWindow[i] as number) ** 2;
    for (let lag = this.searchMin; lag <= this.searchMax; lag++) {
      let dot = 0;
      let refEnergy = 0;
      const offset = this.searchMax - lag; // índice en refWindow de la muestra que corresponde a micWindow[0]
      for (let i = 0; i < n; i++) {
        const r = this.refWindow[offset + i] as number;
        dot += (this.micWindow[i] as number) * r;
        refEnergy += r * r;
      }
      const corr = dot / Math.sqrt(Math.max(1e-12, micEnergy * refEnergy));
      if (corr > best) {
        best = corr;
        bestLag = lag;
      }
    }
    return { lag: bestLag, correlation: Math.max(0, Math.min(1, best)) };
  }
}
