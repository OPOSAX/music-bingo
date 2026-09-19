/**
 * Codificación de tarjetas para compartirlas por enlace sin servidor.
 * El enlace contiene toda la información que necesita el jugador.
 */

import type { GridSize } from './bingo.js';

export interface SharedCard {
  v: 1;
  /** Código de partida. */
  g: string;
  /** Índice de la tarjeta (0-based). */
  n: number;
  s: GridSize;
  /** Nombre de la lista / partida. */
  t: string;
  /** Celdas: [título, artista] o null si es casilla libre. */
  c: ([string, string] | null)[];
  /** Índice de cada celda en el pool de canciones de la partida (null en la casilla libre). */
  i?: (number | null)[];
  /** Canal de sincronización con el anfitrión (si la partida lo tiene). */
  y?: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipeThrough(bytes: Uint8Array, stream: ReadableWritablePair<Uint8Array, BufferSource>): Promise<Uint8Array> {
  const source = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  const buffer = await new Response(source).arrayBuffer();
  return new Uint8Array(buffer);
}

/** Datos del QR único de la partida: con ellos el jugador pide una tarjeta al anfitrión. */
export interface JoinPayload {
  v: 1;
  /** Código de partida. */
  g: string;
  s: GridSize;
  /** Casilla central libre. */
  f: boolean;
  /** Número de tarjetas. */
  n: number;
  /** Número de canciones del pool. */
  p: number;
  /** Canal de sincronización. */
  y: string;
  /** Nombre de la lista. */
  t: string;
}

export function encodeJoinPayload(payload: JoinPayload): Promise<string> {
  return encodeObject(payload);
}

export async function decodeJoinPayload(text: string): Promise<JoinPayload> {
  const parsed = (await decodeObject(text)) as JoinPayload;
  if (parsed.v !== 1 || typeof parsed.g !== 'string' || typeof parsed.y !== 'string' || !Number.isInteger(parsed.n) || !Number.isInteger(parsed.p)) {
    throw new Error('Enlace de partida no válido.');
  }
  return parsed;
}

/** Codifica la tarjeta en una cadena apta para URL. Comprime si el navegador lo soporta. */
export function encodeSharedCard(card: SharedCard): Promise<string> {
  return encodeObject(card);
}

export async function encodeObject(value: unknown): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(value));
  if (typeof CompressionStream !== 'undefined') {
    try {
      const compressed = await pipeThrough(json, new CompressionStream('deflate-raw'));
      return 'z' + bytesToBase64Url(compressed);
    } catch {
      /* sin compresión */
    }
  }
  return 'j' + bytesToBase64Url(json);
}

export async function decodeSharedCard(text: string): Promise<SharedCard> {
  const parsed = (await decodeObject(text)) as SharedCard;
  if (parsed.v !== 1 || !Array.isArray(parsed.c) || typeof parsed.g !== 'string') {
    throw new Error('Enlace de tarjeta no válido.');
  }
  return parsed;
}

export async function decodeObject(text: string): Promise<unknown> {
  const kind = text[0];
  const body = base64UrlToBytes(text.slice(1));
  let json: Uint8Array;
  if (kind === 'z') {
    if (typeof DecompressionStream === 'undefined') throw new Error('Este navegador no puede leer el enlace.');
    json = await pipeThrough(body, new DecompressionStream('deflate-raw'));
  } else if (kind === 'j') {
    json = body;
  } else {
    throw new Error('Enlace de tarjeta no válido.');
  }
  return JSON.parse(new TextDecoder().decode(json)) as unknown;
}
