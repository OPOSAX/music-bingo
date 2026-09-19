import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NlmsCanceller, ReferenceEchoCancellerCore, db, estimateDelay, reductionDb, rms } from '../src/concert/audio/dsp.js';

const SR = 16000;

/** Ruido determinista (LCG) con espectro plano: buena "música" de prueba. */
function noise(n: number, seed = 1): Float32Array {
  let s = seed >>> 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s / 4294967296) * 2 - 1;
  }
  return out;
}

/** "Música": mezcla de tonos y ruido filtrado. */
function music(n: number): Float32Array {
  const out = noise(n, 7);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = 0.3 * (out[i] as number) + 0.4 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 330 * t + 1) + 0.2 * Math.sin(2 * Math.PI * 440 * t + 2);
  }
  return out;
}

/** "Voz": tono con vibrato y armónicos, con pausas (para que haya tramos de solo música). */
function voice(n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const on = Math.floor(t / 0.6) % 2 === 1; // canta 0,6 s, calla 0,6 s
    if (!on) continue;
    const f = 262 * (1 + 0.02 * Math.sin(2 * Math.PI * 5 * t));
    out[i] = 0.5 * Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(2 * Math.PI * 2 * f * t) + 0.12 * Math.sin(2 * Math.PI * 3 * f * t);
  }
  return out;
}

/** Simula el camino acústico: retardo + atenuación + reverberación corta. */
function throughRoom(ref: Float32Array, delay: number, gain: number, reverbTaps: number[] = []): Float32Array {
  const out = new Float32Array(ref.length);
  for (let i = 0; i < ref.length; i++) {
    let v = i - delay >= 0 ? gain * (ref[i - delay] as number) : 0;
    reverbTaps.forEach((g, k) => {
      const d = delay + (k + 1) * 23;
      if (i - d >= 0) v += g * (ref[i - d] as number);
    });
    out[i] = v;
  }
  return out;
}

function runCore(mic: Float32Array, ref: Float32Array, core: ReferenceEchoCancellerCore, block = 128): Float32Array {
  const out = new Float32Array(mic.length);
  for (let i = 0; i + block <= mic.length; i += block) {
    out.set(core.process(mic.subarray(i, i + block), ref.subarray(i, i + block)), i);
  }
  return out;
}

function tail(x: Float32Array, seconds: number): Float32Array {
  return x.subarray(x.length - Math.round(seconds * SR));
}

test('estimateDelay encuentra un retardo conocido', () => {
  const ref = noise(SR * 1);
  const mic = throughRoom(ref, 800, 0.5);
  const { lag, correlation } = estimateDelay(mic, ref, 1200);
  assert.equal(lag, 800);
  assert.ok(correlation > 0.9, `correlación ${correlation}`);
});

test('escenario: solo música → el NLMS elimina la música (ERLE alto)', () => {
  const n = SR * 3;
  const ref = music(n);
  const mic = throughRoom(ref, 0, 0.7, [0.2, 0.1]);
  const nlms = new NlmsCanceller({ taps: 128, mu: 0.6 });
  const out = nlms.process(mic, ref);
  const red = reductionDb(tail(mic, 1), tail(out, 1));
  assert.ok(red > 20, `reducción de música ${red.toFixed(1)} dB`);
  assert.ok(nlms.erleDb > 15, `ERLE ${nlms.erleDb.toFixed(1)} dB`);
});

test('escenario: solo voz → sin referencia la voz pasa intacta', () => {
  const n = SR * 2;
  const v = voice(n);
  const nlms = new NlmsCanceller({ taps: 128 });
  const out = nlms.process(v, new Float32Array(n));
  assert.ok(reductionDb(v, out) < 0.1, 'la voz no se altera');
});

test('escenario: música + voz → se reduce la música y se conserva la voz', () => {
  const n = SR * 6;
  const ref = music(n);
  const v = voice(n);
  const echo = throughRoom(ref, 0, 0.7, [0.2]);
  const mic = new Float32Array(n);
  for (let i = 0; i < n; i++) mic[i] = (echo[i] as number) + (v[i] as number);
  const nlms = new NlmsCanceller({ taps: 128, mu: 0.4 });
  const out = nlms.process(mic, ref);
  // Tramo final: música + voz (voz activa en los últimos 0,6 s del ciclo)
  const last = tail(out, 0.5);
  const lastVoice = tail(v, 0.5);
  const lastEcho = tail(echo, 0.5);
  // residuo = salida - voz: lo que queda de la música
  const residual = new Float32Array(last.length);
  for (let i = 0; i < last.length; i++) residual[i] = (last[i] as number) - (lastVoice[i] as number);
  const musicReduction = db(rms(lastEcho) / rms(residual));
  const voicePreservation = db(rms(lastVoice) / rms(residual));
  assert.ok(musicReduction > 10, `reducción de música ${musicReduction.toFixed(1)} dB`);
  assert.ok(voicePreservation > 8, `voz sobre residuo ${voicePreservation.toFixed(1)} dB`);
});

test('escenarios cerca/lejos/reverberación: el núcleo completo estima el retardo y reduce la música', () => {
  for (const [name, delayMs, gain, reverb] of [
    ['cerca del parlante', 40, 0.9, [0.1]],
    ['lejos del parlante', 300, 0.3, [0.25, 0.15, 0.1]],
    ['mucha reverberación', 120, 0.5, [0.4, 0.3, 0.2, 0.1]],
  ] as const) {
    const n = SR * 6;
    const ref = music(n);
    const delay = Math.round((delayMs / 1000) * SR);
    const mic = throughRoom(ref, delay, gain, [...reverb]);
    const core = new ReferenceEchoCancellerCore({ sampleRate: SR, taps: 192, maxDelayMs: 600, analysisMs: 300, mu: 0.5 });
    const out = runCore(mic, ref, core);
    assert.ok(Math.abs(core.delayMs - delayMs) < 3, `${name}: retardo estimado ${core.delayMs.toFixed(1)} ms (real ${delayMs})`);
    const red = reductionDb(tail(mic, 1), tail(out, 1));
    assert.ok(red > 12, `${name}: reducción ${red.toFixed(1)} dB`);
  }
});

test('escenario: dos personas cantando (dos micrófonos, mismo PA) → dos canceladores independientes', () => {
  const n = SR * 4;
  const ref = music(n);
  const micA = throughRoom(ref, 500, 0.6);
  const micB = throughRoom(ref, 2400, 0.4, [0.2]);
  const coreA = new ReferenceEchoCancellerCore({ sampleRate: SR, taps: 128, maxDelayMs: 300, analysisMs: 250 });
  const coreB = new ReferenceEchoCancellerCore({ sampleRate: SR, taps: 128, maxDelayMs: 300, analysisMs: 250 });
  const outA = runCore(micA, ref, coreA);
  const outB = runCore(micB, ref, coreB);
  assert.ok(Math.abs(coreA.delayMs - (500 / SR) * 1000) < 2);
  assert.ok(Math.abs(coreB.delayMs - (2400 / SR) * 1000) < 2);
  assert.ok(reductionDb(tail(micA, 1), tail(outA, 1)) > 12);
  assert.ok(reductionDb(tail(micB, 1), tail(outB, 1)) > 12);
});

test('el retardo se puede fijar manualmente', () => {
  const core = new ReferenceEchoCancellerCore({ sampleRate: SR });
  core.setDelayMs(250);
  assert.equal(Math.round(core.delayMs), 250);
});
