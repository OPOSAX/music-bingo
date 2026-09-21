/** Persistencia en localStorage del estado de la partida y de las marcas del jugador. */

import type { Card, GameConfig, Track } from './bingo.js';
import { generateCards, playOrder } from './bingo.js';
import { newTopic } from './sync.js';

export interface GameState {
  version: 1;
  createdAt: number;
  config: GameConfig;
  playlistName: string;
  tracks: Track[];
  /** Orden de reproducción: índices dentro de `tracks`. */
  order: number[];
  /** Número de canciones ya cantadas: order[0..position). */
  position: number;
  /** Si el título de la canción actual se muestra en pantalla. */
  revealed: boolean;
  /** Nombre del jugador de cada tarjeta (clave: índice de tarjeta). */
  names?: Record<string, string>;
  /** Canal de sincronización con las tarjetas de los jugadores. */
  syncTopic?: string;
  /** Mensaje del anfitrión visible en las tarjetas sincronizadas. */
  message?: string;
  messageAt?: number;
  /** Último fragmento reproducido: instante de inicio, posición en la canción y duración (ms). */
  lastPlay?: { at: number; pos: number; len: number };
  /** Tarjetas asignadas por el QR único: índice → { n: nombre, c: id del cliente }. */
  claims?: Record<string, { n: string; c: string }>;
  /** Cuándo se publicó la lista de canciones en el canal (para el QR único). */
  poolPublishedAt?: number;
  /** Servidor Live al que se envió la configuración de la partida (vacío = solo canal ntfy). */
  poolPublishedLive?: string;
  /** Servidor Bingo Hit Live (WebRTC + WebSocket) asociado a la partida, si el anfitrión lo activó. */
  liveServer?: string | undefined;
  /** Evento de la plataforma Bingo Hit al que pertenece esta partida (sala Live `bingo-<evento>`). */
  eventId?: string | undefined;
}

const PLAYER_ID_KEY = 'musicbingo:playerId';
const ASSIGNMENT_PREFIX = 'musicbingo:assignment:';

/** Identificador estable de este dispositivo como jugador. */
export function playerId(): string {
  let id = localStorage.getItem(PLAYER_ID_KEY);
  if (!id) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(PLAYER_ID_KEY, id);
  }
  return id;
}

export interface Assignment {
  index: number;
  name: string;
}

export function loadAssignment(seed: string): Assignment | null {
  return read<Assignment>(`${ASSIGNMENT_PREFIX}${seed}`);
}

export function saveAssignment(seed: string, assignment: Assignment | null): void {
  if (assignment) write(`${ASSIGNMENT_PREFIX}${seed}`, assignment);
  else localStorage.removeItem(`${ASSIGNMENT_PREFIX}${seed}`);
}

const GAME_KEY = 'musicbingo:game';
const MARKS_PREFIX = 'musicbingo:marks:';

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.error('No se pudo guardar en localStorage', err);
  }
}

export function loadGame(): GameState | null {
  const game = read<GameState>(GAME_KEY);
  return game && game.version === 1 ? game : null;
}

export function saveGame(game: GameState): void {
  write(GAME_KEY, game);
}

export function clearGame(): void {
  localStorage.removeItem(GAME_KEY);
}

export function createGame(config: GameConfig, playlistName: string, tracks: Track[]): GameState {
  return {
    version: 1,
    createdAt: Date.now(),
    config,
    playlistName,
    tracks,
    order: playOrder(config, tracks.length),
    position: 0,
    revealed: false,
    syncTopic: newTopic(config.seed),
  };
}

export function gameCards(game: GameState): Card[] {
  return generateCards(game.config, game.tracks.length);
}

export function calledSet(game: GameState): Set<number> {
  return new Set(game.order.slice(0, game.position));
}

export function cardName(game: GameState, index: number): string {
  return game.names?.[String(index)]?.trim() ?? '';
}

export function setCardName(game: GameState, index: number, name: string): void {
  const names = { ...(game.names ?? {}) };
  if (name.trim()) names[String(index)] = name.trim();
  else delete names[String(index)];
  game.names = names;
  saveGame(game);
}

/** Etiqueta de una tarjeta para mostrar: nombre del jugador o "Tarjeta n". */
export function cardTitle(game: GameState, index: number): string {
  const name = cardName(game, index);
  return name ? `${name} (#${index + 1})` : `Tarjeta ${index + 1}`;
}

export function currentTrackIndex(game: GameState): number | null {
  if (game.position === 0) return null;
  return game.order[game.position - 1] ?? null;
}

/* ---- Marcas del jugador (por tarjeta) ---- */

export function loadMarks(seed: string, cardIndex: number, size: number): boolean[] {
  const marks = read<boolean[]>(`${MARKS_PREFIX}${seed}:${cardIndex}`);
  if (marks && marks.length === size) return marks;
  return new Array<boolean>(size).fill(false);
}

export function saveMarks(seed: string, cardIndex: number, marks: boolean[]): void {
  write(`${MARKS_PREFIX}${seed}:${cardIndex}`, marks);
}
