/** Reproductor: Web Playback SDK en el navegador o cualquier otro dispositivo de Spotify vía Web API. */

import { getAccessToken } from './auth.js';
import type { StartMode, Track } from './bingo.js';
import * as api from './spotify-api.js';

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';

let sdkPromise: Promise<void> | null = null;

/** Carga el script del SDK una sola vez. */
export function loadSdk(): Promise<void> {
  if (window.Spotify) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<void>((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error('No se pudo cargar el reproductor de Spotify. Comprueba la conexión o el bloqueador de anuncios.'));
    };
    document.head.appendChild(script);
  });
  return sdkPromise;
}

export interface BrowserPlayer {
  deviceId: string;
  player: Spotify.Player;
}

/** Crea y conecta un reproductor en el navegador. Resuelve cuando Spotify le asigna un device_id. */
export async function createBrowserPlayer(name: string, onError: (message: string) => void): Promise<BrowserPlayer> {
  if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
    throw new Error('El reproductor del navegador no funciona en móviles. Elige un dispositivo con la app de Spotify abierta.');
  }
  await loadSdk();
  const SpotifyNs = window.Spotify;
  if (!SpotifyNs) throw new Error('El SDK de Spotify no está disponible.');
  const player = new SpotifyNs.Player({
    name,
    volume: 0.8,
    getOAuthToken: (cb) => {
      getAccessToken().then(cb).catch((err) => onError(String(err.message ?? err)));
    },
  });

  return new Promise<BrowserPlayer>((resolve, reject) => {
    let settled = false;
    const fail = (message: string) => {
      if (!settled) {
        settled = true;
        player.disconnect();
        reject(new Error(message));
      } else {
        onError(message);
      }
    };
    player.addListener('ready', ({ device_id }) => {
      if (!settled) {
        settled = true;
        resolve({ deviceId: device_id, player });
      }
    });
    player.addListener('not_ready', () => onError('El reproductor del navegador se ha desconectado.'));
    player.addListener('initialization_error', ({ message }) =>
      fail(`Este navegador no puede reproducir Spotify (${message}). Prueba con Chrome, Edge o Firefox.`),
    );
    player.addListener('authentication_error', ({ message }) => fail(`Error de autenticación: ${message}`));
    player.addListener('account_error', () =>
      fail('Se necesita Spotify Premium para reproducir música en el navegador.'),
    );
    player.addListener('playback_error', ({ message }) => onError(`Error de reproducción: ${message}`));
    // Desbloquea el audio en navegadores con políticas de autoplay (debe llamarse tras un clic).
    player.activateElement?.().catch(() => undefined);
    player.connect().then((ok) => {
      if (!ok) fail('No se pudo conectar el reproductor de Spotify.');
    });
    setTimeout(() => fail('Spotify no ha respondido. Recarga la página e inténtalo de nuevo.'), 20_000);
  });
}

/** Calcula el punto de inicio del fragmento en milisegundos. */
export function snippetStart(track: Track, mode: StartMode, snippetSeconds: number, rand = Math.random): number {
  const snippetMs = snippetSeconds * 1000;
  const latest = Math.max(0, track.durationMs - snippetMs - 2000);
  if (mode === 'start' || latest === 0) return 0;
  if (mode === 'middle') return Math.min(latest, Math.floor(track.durationMs * 0.38));
  const from = Math.min(latest, Math.floor(track.durationMs * 0.1));
  const to = Math.min(latest, Math.floor(track.durationMs * 0.7));
  return from + Math.floor(rand() * Math.max(0, to - from));
}

export interface SnippetEvents {
  onTick(elapsedMs: number, totalMs: number): void;
  onEnd(): void;
}

/** Reproduce fragmentos de canciones en un dispositivo concreto y los detiene a tiempo. */
export class SnippetPlayer {
  private timer: number | null = null;
  private ticker: number | null = null;
  private generation = 0;

  constructor(public deviceId: string) {}

  async play(track: Track, positionMs: number, seconds: number, events: SnippetEvents): Promise<void> {
    this.cancelTimers();
    const gen = ++this.generation;
    try {
      await api.play(this.deviceId, track.uri, positionMs);
    } catch (err) {
      // Justo después de crear el reproductor, Spotify puede tardar en reconocer el dispositivo (404).
      if (!(err instanceof api.SpotifyApiError && err.status === 404)) throw err;
      await new Promise((r) => setTimeout(r, 1500));
      if (gen !== this.generation) return;
      await api.play(this.deviceId, track.uri, positionMs);
    }
    if (gen !== this.generation) return;
    const totalMs = seconds * 1000;
    const startedAt = performance.now();
    events.onTick(0, totalMs);
    this.ticker = window.setInterval(() => {
      events.onTick(Math.min(totalMs, performance.now() - startedAt), totalMs);
    }, 100);
    this.timer = window.setTimeout(() => {
      this.cancelTimers();
      api.pause(this.deviceId).catch(() => undefined);
      events.onTick(totalMs, totalMs);
      events.onEnd();
    }, totalMs);
  }

  async stop(): Promise<void> {
    this.generation++;
    this.cancelTimers();
    await api.pause(this.deviceId).catch(() => undefined);
  }

  private cancelTimers(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    if (this.ticker !== null) window.clearInterval(this.ticker);
    this.timer = null;
    this.ticker = null;
  }
}
