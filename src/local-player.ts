/**
 * Reproductor de la biblioteca propia: un <audio> en el navegador del anfitrión con la misma interfaz que el
 * SnippetPlayer de Spotify (play/stop de fragmentos). Como el audio no está protegido, la mesa de mezcla puede
 * tomarlo directamente (`audioSource`) y enviarlo a los jugadores.
 */

import type { Track } from './bingo.js';
import { songIdOf, songUrl } from './library/api.js';
import type { SnippetEvents } from './player.js';

let shared: LocalSnippetPlayer | null = null;

/** Un único reproductor por pestaña (el elemento <audio> solo puede entrar una vez en Web Audio). */
export function localPlayer(): LocalSnippetPlayer {
  shared ??= new LocalSnippetPlayer();
  return shared;
}

export class LocalSnippetPlayer {
  readonly deviceId = 'local';
  readonly element: HTMLAudioElement;
  private timer: number | null = null;
  private ticker: number | null = null;
  private generation = 0;
  private source: MediaElementAudioSourceNode | null = null;
  private sourceCtx: AudioContext | null = null;

  constructor() {
    this.element = new Audio();
    this.element.preload = 'auto';
    this.element.crossOrigin = 'anonymous';
    this.element.volume = 0.8;
  }

  get volume(): number {
    return this.element.volume;
  }

  set volume(v: number) {
    this.element.volume = Math.max(0, Math.min(1, v));
  }

  async play(track: Track, positionMs: number, seconds: number, events: SnippetEvents): Promise<void> {
    this.cancelTimers();
    const gen = ++this.generation;
    const el = this.element;
    const url = songUrl(songIdOf(track));
    if (el.dataset.url !== url) {
      el.src = url;
      el.dataset.url = url;
      await new Promise<void>((resolve, reject) => {
        const ok = () => {
          cleanup();
          resolve();
        };
        const bad = () => {
          cleanup();
          reject(new Error(`No se pudo cargar "${track.name}" desde la biblioteca`));
        };
        const cleanup = () => {
          el.removeEventListener('loadedmetadata', ok);
          el.removeEventListener('error', bad);
        };
        el.addEventListener('loadedmetadata', ok);
        el.addEventListener('error', bad);
        el.load();
      });
      if (gen !== this.generation) return;
    }
    el.loop = !!(events.keepPlaying && events.loop);
    el.currentTime = Math.max(0, positionMs / 1000);
    await el.play();
    if (gen !== this.generation) return;
    const totalMs = seconds * 1000;
    const startedAt = performance.now();
    events.onTick(0, totalMs);
    this.ticker = window.setInterval(() => events.onTick(Math.min(totalMs, performance.now() - startedAt), totalMs), 100);
    this.timer = window.setTimeout(() => {
      this.cancelTimers();
      if (!events.keepPlaying) el.pause();
      events.onTick(totalMs, totalMs);
      events.onEnd();
    }, totalMs);
  }

  async stop(): Promise<void> {
    this.generation++;
    this.cancelTimers();
    this.element.pause();
    this.element.loop = false;
  }

  /**
   * Nodo de Web Audio con el audio del reproductor (una sola vez por contexto). Al crearlo, el <audio> deja de sonar
   * por sí mismo: quien lo pida debe conectarlo a la salida (monitor) o devolverlo con `releaseSource`.
   */
  audioSource(ctx: AudioContext): MediaElementAudioSourceNode {
    if (this.source && this.sourceCtx === ctx) return this.source;
    this.source = ctx.createMediaElementSource(this.element);
    this.sourceCtx = ctx;
    return this.source;
  }

  /** Vuelve a sonar directamente por los altavoces cuando la mesa de mezcla se cierra. */
  releaseSource(): void {
    if (!this.source || !this.sourceCtx) return;
    try {
      this.source.disconnect();
    } catch {
      /* ya desconectado */
    }
    this.source.connect(this.sourceCtx.destination);
  }

  private cancelTimers(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    if (this.ticker !== null) window.clearInterval(this.ticker);
    this.timer = null;
    this.ticker = null;
  }
}
