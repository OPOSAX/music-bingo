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
  /** Últimas canciones con el título revelado, en orden cronológico: [nº, título, artista]. */
  log?: [number, string, string][];
  /** Mensaje del anfitrión a los jugadores. */
  msg?: { text: string; t: number } | null;
  /** Canción en curso, solo si el anfitrión activa las letras (para buscarla en LRCLIB). */
  cur?: { id: string; name: string; artists: string; album: string; durationMs: number } | null;
  /** Reloj del último fragmento reproducido, para sincronizar la letra. */
  play?: { at: number; pos: number; len: number } | null;
  /** Tarjetas asignadas por el QR único: índice → { n: nombre, c: id del cliente }. */
  claims?: Record<string, { n: string; c: string }>;
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

/** Cuántas canciones reveladas se envían a los jugadores (el mensaje debe ser pequeño). */
export const LOG_LIMIT = 12;

/** Lista de canciones de la partida, troceada para caber en mensajes del canal. */
export interface PoolMessage {
  k: 'pool';
  seed: string;
  /** Trozo i de n. */
  i: number;
  n: number;
  /** Índice del primer elemento del trozo dentro del pool. */
  from: number;
  /** [título, artista] por canción. */
  items: [string, string][];
}

/** Petición de tarjeta de un jugador que escaneó el QR único. */
export interface ClaimMessage {
  k: 'claim';
  seed: string;
  index: number;
  name: string;
  /** Identificador del cliente que pide la tarjeta. */
  cid: string;
  t: number;
}

export type SyncMessage = { k: 'state'; state: SyncState } | PoolMessage | ClaimMessage;

const POOL_CHUNK_BYTES = 3000;

export function poolChunks(seed: string, items: [string, string][]): PoolMessage[] {
  const groups: [string, string][][] = [];
  let current: [string, string][] = [];
  let size = 0;
  for (const item of items) {
    const itemSize = JSON.stringify(item).length + 1;
    if (current.length > 0 && size + itemSize > POOL_CHUNK_BYTES) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += itemSize;
  }
  if (current.length > 0 || groups.length === 0) groups.push(current);
  let from = 0;
  return groups.map((group, i) => {
    const msg: PoolMessage = { k: 'pool', seed, i, n: groups.length, from, items: group };
    from += group.length;
    return msg;
  });
}

/** Reconstruye el pool a partir de los trozos recibidos; null si falta alguno. */
export function assemblePool(chunks: Map<number, PoolMessage>, total: number): [string, string][] | null {
  const first = chunks.get(0);
  if (!first) return null;
  const items: [string, string][] = [];
  for (let i = 0; i < first.n; i++) {
    const chunk = chunks.get(i);
    if (!chunk) return null;
    items.push(...chunk.items);
  }
  return items.length >= total ? items.slice(0, total) : null;
}

/** Índice de tarjeta más bajo que no está asignado a otro cliente. */
export function nextFreeIndex(claims: Record<string, { n: string; c: string }> | undefined, cardCount: number, cid: string, after = -1): number | null {
  for (let i = after + 1; i < cardCount; i++) {
    const claim = claims?.[String(i)];
    if (!claim || claim.c === cid) return i;
  }
  return null;
}

export function parseSyncMessage(text: string): SyncMessage | null {
  try {
    const data = JSON.parse(text) as { k?: string; seed?: string };
    if (data.k === 'pool') {
      const pool = data as PoolMessage;
      if (typeof pool.seed !== 'string' || !Array.isArray(pool.items) || !Number.isInteger(pool.i) || !Number.isInteger(pool.n)) return null;
      return pool;
    }
    if (data.k === 'claim') {
      const claim = data as ClaimMessage;
      if (typeof claim.seed !== 'string' || !Number.isInteger(claim.index) || typeof claim.cid !== 'string') return null;
      return { ...claim, name: String(claim.name ?? '').slice(0, 40), t: Number(claim.t) || 0 };
    }
  } catch {
    return null;
  }
  const state = parseSyncState(text);
  return state ? { k: 'state', state } : null;
}

export function buildSyncState(game: GameState): SyncState {
  const called = game.order.slice(0, game.position);
  const last = called.length ? game.tracks[called[called.length - 1] as number] : undefined;
  const revealedCount = game.revealed ? called.length : Math.max(0, called.length - 1);
  const log: [number, string, string][] = called.slice(Math.max(0, revealedCount - LOG_LIMIT), revealedCount).map((idx, i, arr) => {
    const track = game.tracks[idx];
    const n = revealedCount - arr.length + i + 1;
    return [n, track?.name ?? '', track?.artists ?? ''];
  });
  return {
    v: 1,
    seed: game.config.seed,
    called,
    revealed: game.revealed,
    now: game.revealed && last ? { name: last.name, artists: last.artists } : null,
    log,
    msg: game.message ? { text: game.message, t: game.messageAt ?? 0 } : null,
    cur: game.config.lyrics !== false && last ? { id: last.id, name: last.name, artists: last.artists, album: last.album, durationMs: last.durationMs } : null,
    play: game.config.lyrics !== false && game.lastPlay ? game.lastPlay : null,
    claims: game.claims ?? {},
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
      log: Array.isArray(data.log) ? data.log.filter((e): e is [number, string, string] => Array.isArray(e) && e.length === 3) : [],
      msg: data.msg && typeof data.msg.text === 'string' ? { text: data.msg.text, t: Number(data.msg.t) || 0 } : null,
      cur: data.cur && typeof data.cur.id === 'string' && typeof data.cur.name === 'string' ? { id: data.cur.id, name: data.cur.name, artists: String(data.cur.artists ?? ''), album: String(data.cur.album ?? ''), durationMs: Number(data.cur.durationMs) || 0 } : null,
      play: data.play && typeof data.play.at === 'number' ? { at: data.play.at, pos: Number(data.play.pos) || 0, len: Number(data.play.len) || 0 } : null,
      claims: data.claims && typeof data.claims === 'object' ? data.claims : {},
      autoMark: data.autoMark === 'revealed' || data.autoMark === 'off' ? data.autoMark : 'played',
      t: typeof data.t === 'number' ? data.t : 0,
    };
  } catch {
    return null;
  }
}

/** Publica un mensaje en el canal. Devuelve false si no se pudo enviar. */
export async function publishMessage(topic: string, message: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${relayBase()}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Title: 'bingo', Priority: 'min' },
      body: JSON.stringify(message),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Publica el estado en el canal. Devuelve false si no se pudo enviar. */
export function publishState(topic: string, state: SyncState): Promise<boolean> {
  return publishMessage(topic, state);
}

export interface Subscription {
  close(): void;
}

/**
 * Se suscribe al canal y entrega el estado más reciente (incluido el histórico guardado
 * en el servidor, para que un jugador que llega tarde vea las canciones ya cantadas).
 */
export function subscribeState(topic: string, onState: (state: SyncState) => void, onStatus?: (online: boolean) => void): Subscription {
  return subscribeTopic(topic, (msg) => {
    if (msg.k === 'state') onState(msg.state);
  }, onStatus);
}

/** Se suscribe a todos los mensajes del canal (estado, pool y peticiones), incluido el histórico. */
export function subscribeTopic(topic: string, onMessage: (message: SyncMessage) => void, onStatus?: (online: boolean) => void): Subscription {
  const url = `${relayBase()}/${encodeURIComponent(topic)}/sse?since=all`;
  const source = new EventSource(url);
  let latestState = 0;
  const seen = new Set<string>();
  source.onopen = () => onStatus?.(true);
  source.onerror = () => onStatus?.(false);
  source.onmessage = (ev: MessageEvent<string>) => {
    let envelope: { id?: string; event?: string; message?: string };
    try {
      envelope = JSON.parse(ev.data) as { id?: string; event?: string; message?: string };
    } catch {
      return;
    }
    if (envelope.event && envelope.event !== 'message') return;
    if (envelope.id) {
      if (seen.has(envelope.id)) return;
      seen.add(envelope.id);
    }
    const msg = parseSyncMessage(envelope.message ?? '');
    if (!msg) return;
    if (msg.k === 'state') {
      if (msg.state.t < latestState) return;
      latestState = msg.state.t;
    }
    onMessage(msg);
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
