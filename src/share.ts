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

/** Codifica la tarjeta en una cadena apta para URL. Comprime si el navegador lo soporta. */
export async function encodeSharedCard(card: SharedCard): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(card));
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
  const parsed = JSON.parse(new TextDecoder().decode(json)) as SharedCard;
  if (parsed.v !== 1 || !Array.isArray(parsed.c) || typeof parsed.g !== 'string') {
    throw new Error('Enlace de tarjeta no válido.');
  }
  return parsed;
}
