/** Cliente ligero de la Spotify Web API. */

import { AuthError, getAccessToken } from './auth.js';
import type { Track } from './bingo.js';

const BASE = 'https://api.spotify.com/v1';

export class SpotifyApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export interface SpotifyUser {
  id: string;
  display_name: string | null;
  product?: string;
  images?: { url: string }[];
}

export interface PlaylistSummary {
  id: string;
  name: string;
  owner: string;
  /** Número de canciones, o null si la API no lo informa. */
  trackCount: number | null;
  image: string | null;
}

export interface Device {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
}

interface Page<T> {
  items: T[];
  next: string | null;
  total: number;
}

interface ApiTrack {
  id: string | null;
  uri: string;
  name: string;
  type?: string;
  is_local?: boolean;
  is_playable?: boolean;
  duration_ms: number;
  artists: { name: string }[];
  album: { name: string; images: { url: string; width: number | null }[] };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const token = await getAccessToken();
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });

  if (res.status === 401 && retry) {
    await getAccessToken(true);
    return request<T>(path, init, false);
  }
  if (res.status === 429 && retry) {
    const wait = Number(res.headers.get('Retry-After') ?? '1');
    await sleep(Math.min(wait, 10) * 1000);
    return request<T>(path, init, false);
  }
  if (!res.ok) {
    let message = `Spotify ha devuelto el error ${res.status}.`;
    try {
      const data = (await res.json()) as { error?: { message?: string; reason?: string } };
      if (data.error?.message) message = `${data.error.message} (HTTP ${res.status} en ${path.split('?')[0]})`;
      if (data.error?.reason) message += ` [${data.error.reason}]`;
    } catch {
      /* sin cuerpo */
    }
    if (res.status === 401) throw new AuthError('La sesión de Spotify ha caducado. Vuelve a iniciar sesión.');
    if (res.status === 403 && /premium/i.test(message)) {
      message = 'Esta función requiere una cuenta Spotify Premium.';
    }
    throw new SpotifyApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function paginate<T>(firstPath: string, onProgress?: (loaded: number, total: number) => void): Promise<T[]> {
  const items: T[] = [];
  let next: string | null = firstPath;
  while (next) {
    const page: Page<T> = await request<Page<T>>(next);
    items.push(...page.items);
    onProgress?.(items.length, page.total);
    next = page.next;
  }
  return items;
}

export function getMe(): Promise<SpotifyUser> {
  return request<SpotifyUser>('/me');
}

interface ApiPlaylist {
  id: string;
  name: string;
  owner?: { display_name?: string; id?: string } | null;
  /** Nombre clásico del campo con el total de canciones. */
  tracks?: { total?: number } | null;
  /** Nombre nuevo del campo en versiones recientes de la API. */
  items?: { total?: number } | null;
  images?: { url: string }[] | null;
}

function toSummary(p: ApiPlaylist): PlaylistSummary {
  const total = p.tracks?.total ?? p.items?.total;
  return {
    id: p.id,
    name: p.name,
    owner: p.owner?.display_name || p.owner?.id || '',
    trackCount: typeof total === 'number' ? total : null,
    image: p.images?.[0]?.url ?? null,
  };
}

export async function getMyPlaylists(): Promise<PlaylistSummary[]> {
  const items = await paginate<ApiPlaylist | null>('/me/playlists?limit=50');
  return items.filter((p): p is ApiPlaylist => p !== null && !!p.id).map(toSummary);
}

export function getPlaylistSummary(id: string): Promise<PlaylistSummary> {
  return request<ApiPlaylist>(`/playlists/${encodeURIComponent(id)}`).then(toSummary);
}

function toTrack(t: ApiTrack | null | undefined): Track | null {
  if (!t || !t.id || !t.uri || t.is_local || (t.type && t.type !== 'track')) return null;
  const images = t.album?.images ?? [];
  const small = images.length ? images[images.length - 1] : undefined;
  return {
    id: t.id,
    uri: t.uri,
    name: t.name,
    artists: (t.artists ?? []).map((a) => a.name).join(', '),
    album: t.album?.name ?? '',
    durationMs: t.duration_ms,
    image: small?.url ?? null,
  };
}

/** Elimina duplicados (misma canción o mismo título+artista). */
export function dedupeTracks(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const t of tracks) {
    const key = `${t.name.toLowerCase().trim()}|${t.artists.toLowerCase().trim()}`;
    if (seen.has(t.id) || seen.has(key)) continue;
    seen.add(t.id);
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Elemento de una lista: la API lo llama `track` (clásico) o `item` (versiones recientes). */
interface PlaylistItem {
  track?: ApiTrack | null;
  item?: ApiTrack | null;
}

function itemsToTracks(items: PlaylistItem[]): Track[] {
  return dedupeTracks(items.map((i) => toTrack(i.track ?? i.item)).filter((t): t is Track => t !== null));
}

export async function getPlaylistTracks(
  id: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Track[]> {
  const encoded = encodeURIComponent(id);
  // Desde febrero de 2026 la ruta es /items (la antigua /tracks devuelve 403 o 404).
  const paths = [`/playlists/${encoded}/items?limit=100`, `/playlists/${encoded}/tracks?limit=100`];
  let lastError: unknown = null;
  for (const path of paths) {
    try {
      const items = await paginate<PlaylistItem>(path, onProgress);
      return itemsToTracks(items);
    } catch (err) {
      if (!(err instanceof SpotifyApiError && (err.status === 403 || err.status === 404))) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

export async function getSavedTracks(onProgress?: (loaded: number, total: number) => void): Promise<Track[]> {
  const items = await paginate<PlaylistItem>('/me/tracks?limit=50', onProgress);
  return itemsToTracks(items);
}

export async function getDevices(): Promise<Device[]> {
  const data = await request<{ devices: Device[] }>('/me/player/devices');
  return data.devices.filter((d) => d.id);
}

export function play(deviceId: string, uri: string, positionMs: number): Promise<void> {
  return request<void>(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
    method: 'PUT',
    body: JSON.stringify({ uris: [uri], position_ms: Math.max(0, Math.floor(positionMs)) }),
  });
}

export async function pause(deviceId: string): Promise<void> {
  try {
    await request<void>(`/me/player/pause?device_id=${encodeURIComponent(deviceId)}`, { method: 'PUT' });
  } catch (err) {
    // Spotify devuelve 403 "Restriction violated" si ya está en pausa: no es un error real.
    if (err instanceof SpotifyApiError && (err.status === 403 || err.status === 404)) return;
    throw err;
  }
}

/** Extrae el ID de una lista a partir de una URL, un URI o el propio ID. */
export function parsePlaylistInput(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const uri = text.match(/^spotify:playlist:([A-Za-z0-9]+)$/);
  if (uri) return uri[1] ?? null;
  const url = text.match(/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?playlist\/([A-Za-z0-9]+)/);
  if (url) return url[1] ?? null;
  if (/^[A-Za-z0-9]{16,}$/.test(text)) return text;
  return null;
}
