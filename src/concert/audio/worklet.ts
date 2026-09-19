/**
 * AudioWorklet de CROWD MIC: cancelador por referencia (NLMS de dos filtros) y compuerta
 * de ruido. Se compila a public/js/concert/audio/worklet.js y se carga con addModule().
 * Entradas: [0] micrófono del teléfono (consumer del DJ), [1] MUSIC_REFERENCE. Salida: voz estimada.
 */

import { ReferenceEchoCancellerCore, rms } from './dsp.js';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

type Mode = 'RAW' | 'AEC' | 'FINAL';

class ReferenceAecProcessor extends AudioWorkletProcessor {
  private core: ReferenceEchoCancellerCore;
  private enabled = true;
  private bypassGate = false;
  private gateStrength = 0.3; // 0 = sin compuerta; 1 = compuerta agresiva
  private gateThreshold = 0.01;
  private envelope = 0;
  private frames = 0;
  private lastRawRms = 0;
  private lastOutRms = 0;

  constructor() {
    super();
    this.core = new ReferenceEchoCancellerCore({ sampleRate, taps: 512, maxDelayMs: 1000, analysisMs: 400, mu: 0.4 });
    this.port.onmessage = (ev: MessageEvent<{ type: string; value?: number; mode?: Mode; enabled?: boolean; delayMs?: number; maxDelayMs?: number }>) => {
      const m = ev.data;
      if (m.type === 'aec') this.enabled = m.enabled !== false;
      if (m.type === 'gate') this.gateStrength = Math.max(0, Math.min(1, m.value ?? 0));
      if (m.type === 'gateThreshold') this.gateThreshold = Math.max(0, m.value ?? 0.01);
      if (m.type === 'delay' && typeof m.delayMs === 'number') this.core.setDelayMs(m.delayMs);
      if (m.type === 'reset') this.core = new ReferenceEchoCancellerCore({ sampleRate, taps: 512, maxDelayMs: m.maxDelayMs ?? 1000, analysisMs: 400, mu: 0.4 });
      if (m.type === 'bypassGate') this.bypassGate = m.enabled === true;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const mic = inputs[0]?.[0];
    const out = outputs[0]?.[0];
    if (!mic || !out) return true;
    const ref = inputs[1]?.[0] ?? new Float32Array(mic.length);
    let signal: Float32Array;
    if (this.enabled) signal = this.core.process(mic, ref, out);
    else {
      out.set(mic);
      signal = out;
    }
    if (!this.bypassGate && this.gateStrength > 0) this.gate(signal);
    this.lastRawRms = rms(mic);
    this.lastOutRms = rms(signal);
    if (++this.frames % 32 === 0) {
      this.port.postMessage({
        type: 'metrics',
        referenceDelayMs: this.core.delayMs,
        referenceCorrelation: this.core.correlation,
        erleDb: this.core.erleDb,
        doubleTalk: this.core.doubleTalk,
        inputRms: this.lastRawRms,
        outputRms: this.lastOutRms,
      });
    }
    return true;
  }

  /** Expansor descendente sencillo: atenúa cuando la señal cae por debajo del umbral (respeta las notas suaves con ataque/relajación). */
  private gate(signal: Float32Array): void {
    const level = rms(signal);
    const attack = 0.3;
    const release = 0.02;
    this.envelope = level > this.envelope ? this.envelope + attack * (level - this.envelope) : this.envelope + release * (level - this.envelope);
    if (this.envelope < this.gateThreshold) {
      const gain = 1 - this.gateStrength * (1 - this.envelope / this.gateThreshold);
      for (let i = 0; i < signal.length; i++) signal[i] = (signal[i] as number) * gain;
    }
  }
}

registerProcessor('crowd-mic-aec', ReferenceAecProcessor);
