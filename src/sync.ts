/**
 * Sincronización anfitrión → jugadores sin servidor propio.
 * Se usa un canal de mensajes (ntfy.sh por defecto, o cualquier servidor ntfy) con un
 * identificador secreto por partida: el anfitrión publica el estado y las tarjetas se suscriben.
 */

import type { GameState } from './store.js';

export type AutoMark = 'played' | 'revealed' | 'off';

/** Estado que el anfitrión comparte con los jugadores. */
export interface SyncState {
  v: 1;
  /** Código de partida. */
  seed: string;
  /** Índices (en el pool de la partida) de las canciones ya cantadas, en orden. */
  called: number[];
  /** Si el título de la última canción está revelado. */
  revealed: boolean;
  /** Título y artista de la última canción, solo si está revelada. */
  now?: { name: string; artists: string } | null;
  autoMark: AutoMark;
  /** Momento de publicación (ms). */
  t: number;
}

const RELAY_KEY = 'musicbingo:relay';
export const DEFAULT_RELAY = 'https://ntfy.sh';

export function relayBase(): string {
  return (localStorage.getItem(RELAY_KEY) || DEFAULT_RELAY).replace(/\/+$/, '');
}

export function setRelayBase(url: string): void {
  const clean = url.trim().replace(/\/+$/, '');
  if (clean && clean !== DEFAULT_RELAY) localStorage.setItem(RELAY_KEY, clean);
  else localStorage.removeItem(RELAY_KEY);
}

/** Identificador de canal nuevo, imposible de adivinar. */
export function newTopic(seed: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `mbingo-${seed.toLowerCase()}-${hex}`;
}

export function buildSyncState(game: GameState): SyncState {
  const called = game.order.slice(0, game.position);
  const last = called.length ? game.tracks[called[called.length - 1] as number] : undefined;
  return {
    v: 1,
    seed: game.config.seed,
    called,
    revealed: game.revealed,
    now: game.revealed && last ? { name: last.name, artists: last.artists } : null,
    autoMark: game.config.autoMark ?? 'played',
    t: Date.now(),
  };
}

export function parseSyncState(text: string): SyncState | null {
  try {
    const data = JSON.parse(text) as Partial<SyncState>;
    if (data.v !== 1 || typeof data.seed !== 'string' || !Array.isArray(data.called)) return null;
    return {
      v: 1,
      seed: data.seed,
      called: data.called.filter((n): n is number => Number.isInteger(n)),
      revealed: data.revealed === true,
      now: data.now ?? null,
      autoMark: data.autoMark === 'revealed' || data.autoMark === 'off' ? data.autoMark : 'played',
      t: typeof data.t === 'number' ? data.t : 0,
    };
  } catch {
    return null;
  }
}

/** Publica el estado en el canal. Devuelve false si no se pudo enviar. */
export async function publishState(topic: string, state: SyncState): Promise<boolean> {
  try {
    const res = await fetch(`${relayBase()}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Title: 'bingo', Priority: 'min' },
      body: JSON.stringify(state),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface Subscription {
  close(): void;
}

/**
 * Se suscribe al canal y entrega el estado más reciente (incluido el histórico guardado
 * en el servidor, para que un jugador que llega tarde vea las canciones ya cantadas).
 */
export function subscribeState(topic: string, onState: (state: SyncState) => void, onStatus?: (online: boolean) => void): Subscription {
  const url = `${relayBase()}/${encodeURIComponent(topic)}/sse?since=all`;
  const source = new EventSource(url);
  let latest: SyncState | null = null;
  source.onopen = () => onStatus?.(true);
  source.onerror = () => onStatus?.(false);
  source.onmessage = (ev: MessageEvent<string>) => {
    let envelope: { event?: string; message?: string };
    try {
      envelope = JSON.parse(ev.data) as { event?: string; message?: string };
    } catch {
      return;
    }
    if (envelope.event && envelope.event !== 'message') return;
    const state = parseSyncState(envelope.message ?? '');
    if (!state) return;
    if (latest && state.t < latest.t) return;
    latest = state;
    onState(state);
  };
  return { close: () => source.close() };
}

/** Calcula qué celdas de una tarjeta quedan marcadas automáticamente según el estado. */
export function autoMarkedCells(cells: (number | null)[], state: SyncState | null): boolean[] {
  if (!state || state.autoMark === 'off') return cells.map(() => false);
  let called = state.called;
  if (state.autoMark === 'revealed' && !state.revealed) called = called.slice(0, -1);
  const set = new Set(called);
  return cells.map((c) => c !== null && set.has(c));
}
