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
  ownerId: string;
  collaborative: boolean;
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
  popularity?: number;
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
  collaborative?: boolean;
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
    ownerId: p.owner?.id ?? '',
    collaborative: p.collaborative === true,
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
  const track: Track = {
    id: t.id,
    uri: t.uri,
    name: t.name,
    artists: (t.artists ?? []).map((a) => a.name).join(', '),
    album: t.album?.name ?? '',
    durationMs: t.duration_ms,
    image: small?.url ?? null,
  };
  if (typeof t.popularity === 'number') track.popularity = t.popularity;
  return track;
}

/** Tamaños de página de la búsqueda: en modo desarrollo Spotify admite como máximo 10 por petición. */
const SEARCH_LIMITS = [10, 5];
let searchLimit = SEARCH_LIMITS[0] as number;

/** Busca canciones con la búsqueda de Spotify (admite filtros como year:1980-1989 o genre:rock). */
export async function searchTracks(query: string, limit = 50, offset = 0, market?: string): Promise<Track[]> {
  for (;;) {
    const params = new URLSearchParams({ q: query, type: 'track', limit: String(Math.min(searchLimit, limit)), offset: String(offset) });
    if (market) params.set('market', market);
    try {
      const data = await request<{ tracks?: { items?: (ApiTrack | null)[] } }>(`/search?${params}`);
      return (data.tracks?.items ?? []).map((t) => toTrack(t)).filter((t): t is Track => t !== null);
    } catch (err) {
      // "Invalid limit": el máximo permitido es menor; se prueba con el siguiente tamaño de página.
      const next = SEARCH_LIMITS.find((l) => l < searchLimit);
      if (err instanceof SpotifyApiError && err.status === 400 && /limit/i.test(err.message) && next) {
        searchLimit = next;
        continue;
      }
      throw err;
    }
  }
}

/** Reúne hasta `wanted` canciones para una consulta, paginando con el tamaño de página permitido. */
export async function searchTracksUpTo(query: string, wanted: number, market?: string, maxPages = 6): Promise<Track[]> {
  const out: Track[] = [];
  let offset = 0;
  for (let page = 0; page < maxPages && out.length < wanted; page++) {
    const batch = await searchTracks(query, wanted - out.length, offset, market);
    out.push(...batch);
    if (batch.length === 0 || batch.length < Math.min(searchLimit, wanted - out.length + batch.length)) break;
    offset += batch.length;
  }
  return out;
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
  const attempts: string[] = [];
  const fail = (label: string, err: unknown) => {
    attempts.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  };

  // 1. Ruta vigente desde febrero de 2026.
  try {
    return itemsToTracks(await paginate<PlaylistItem>(`/playlists/${encoded}/items?limit=100`, onProgress));
  } catch (err) {
    fail('/items', err);
  }

  // 2. Objeto completo de la lista: incluye la primera página de elementos y el enlace a las siguientes.
  try {
    const playlist = await request<{ items?: Page<PlaylistItem> | null; tracks?: Page<PlaylistItem> | null }>(`/playlists/${encoded}`);
    const first = playlist.items ?? playlist.tracks;
    if (first && Array.isArray(first.items)) {
      const all = [...first.items];
      onProgress?.(all.length, first.total);
      let next = first.next;
      while (next) {
        const page: Page<PlaylistItem> = await request<Page<PlaylistItem>>(next);
        all.push(...page.items);
        onProgress?.(all.length, page.total);
        next = page.next;
      }
      return itemsToTracks(all);
    }
    fail('/playlists/{id}', new Error('la respuesta no incluye los elementos'));
  } catch (err) {
    fail('/playlists/{id}', err);
  }

  // 3. Ruta antigua, por si la app aún la tuviera disponible.
  try {
    return itemsToTracks(await paginate<PlaylistItem>(`/playlists/${encoded}/tracks?limit=100`, onProgress));
  } catch (err) {
    fail('/tracks', err);
  }

  const forbidden = attempts.every((a) => /HTTP 403/.test(a));
  const hint = forbidden
    ? 'Spotify rechaza leer esta lista (403). Con apps en modo desarrollo solo se pueden leer listas creadas por ti o en las que colaboras, y la cuenta con la que iniciaste sesión debe ser la dueña de la app en el panel de Spotify o estar añadida en "User Management". '
    : 'No se pudo leer la lista. ';
  throw new SpotifyApiError(`${hint}Intentos: ${attempts.join(' | ')}`, forbidden ? 403 : 0);
}

export async function getSavedTracks(onProgress?: (loaded: number, total: number) => void): Promise<Track[]> {
  try {
    return itemsToTracks(await paginate<PlaylistItem>('/me/tracks?limit=50', onProgress));
  } catch (err) {
    if (!(err instanceof SpotifyApiError && (err.status === 403 || err.status === 404))) throw err;
  }
  return itemsToTracks(await paginate<PlaylistItem>('/me/library/tracks?limit=50', onProgress));
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

/** Modo de repetición del dispositivo: 'track' mantiene la canción en bucle (evita que Spotify se pare al acabar). */
export async function setRepeat(deviceId: string, state: 'track' | 'off'): Promise<void> {
  try {
    await request<void>(`/me/player/repeat?state=${state}&device_id=${encodeURIComponent(deviceId)}`, { method: 'PUT' });
  } catch (err) {
    if (err instanceof SpotifyApiError && (err.status === 403 || err.status === 404)) return;
    throw err;
  }
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

/** Crea una lista privada en la cuenta del usuario y añade las canciones. Devuelve el id de la lista. */
export async function createPlaylist(name: string, description: string, tracks: Track[]): Promise<string> {
  let created: { id: string };
  try {
    created = await request<{ id: string }>('/me/playlists', { method: 'POST', body: JSON.stringify({ name, description, public: false }) });
  } catch (err) {
    if (!(err instanceof SpotifyApiError && err.status === 404)) throw err;
    const me = await getMe();
    created = await request<{ id: string }>(`/users/${encodeURIComponent(me.id)}/playlists`, { method: 'POST', body: JSON.stringify({ name, description, public: false }) });
  }
  const uris = tracks.map((t) => t.uri);
  for (let i = 0; i < uris.length; i += 100) {
    const body = JSON.stringify({ uris: uris.slice(i, i + 100) });
    try {
      await request<void>(`/playlists/${encodeURIComponent(created.id)}/items`, { method: 'POST', body });
    } catch (err) {
      if (!(err instanceof SpotifyApiError && err.status === 404)) throw err;
      await request<void>(`/playlists/${encodeURIComponent(created.id)}/tracks`, { method: 'POST', body });
    }
  }
  return created.id;
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
