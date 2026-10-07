/** Cliente de la biblioteca propia: canciones subidas (compartidas) y listas del animador. */

import type { Track } from '../bingo.js';
import { ApiError, api, currentServer, tokens } from '../platform/api.js';

export interface Song {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  size: number;
  ext: string;
  status: 'PENDING' | 'READY';
  uploadedBy: string;
  uploadedByName: string;
  createdAt: string;
}

export interface Playlist {
  id: string;
  hostId: string;
  name: string;
  songIds: string[];
  songs: Song[];
  createdAt: string;
  updatedAt: string;
}

const token = () => tokens.admin() || tokens.host();

export const libraryApi = {
  songs: (q = '') => api<{ songs: Song[]; maxBytes: number; formats: string[] }>('GET', `/api/library/songs${q ? `?q=${encodeURIComponent(q)}` : ''}`, { token: token() }),
  announce: (meta: { hash: string; ext: string; size: number; title: string; artist: string; album?: string; durationMs: number }) => api<{ song: Song; duplicate: boolean }>('POST', '/api/library/songs', { token: token(), body: meta }),
  updateSong: (id: string, patch: Partial<Pick<Song, 'title' | 'artist' | 'album' | 'durationMs'>>) => api<Song>('PATCH', `/api/library/songs/${id}`, { token: token(), body: patch }),
  deleteSong: (id: string) => api<{ deleted: true }>('DELETE', `/api/library/songs/${id}`, { token: token() }),
  playlists: () => api<{ playlists: Playlist[] }>('GET', '/api/library/playlists', { token: token() }),
  playlist: (id: string) => api<Playlist>('GET', `/api/library/playlists/${id}`, { token: token() }),
  createPlaylist: (name: string, songIds: string[] = []) => api<Playlist>('POST', '/api/library/playlists', { token: token(), body: { name, songIds } }),
  updatePlaylist: (id: string, patch: { name?: string; songIds?: string[] }) => api<Playlist>('PATCH', `/api/library/playlists/${id}`, { token: token(), body: patch }),
  deletePlaylist: (id: string) => api<{ deleted: true }>('DELETE', `/api/library/playlists/${id}`, { token: token() }),
};

/** URL del archivo de audio de una canción (el id es la única llave; vale para <audio>). */
export function songUrl(id: string, server = currentServer()): string {
  return `${server}/api/library/songs/${encodeURIComponent(id)}/file`;
}

export const LOCAL_URI_PREFIX = 'local:';

export function isLocalTrack(track: { uri: string }): boolean {
  return track.uri.startsWith(LOCAL_URI_PREFIX);
}

export function songIdOf(track: { uri: string }): string {
  return track.uri.slice(LOCAL_URI_PREFIX.length);
}

/** Canción de la biblioteca como pista de la partida (mismo tipo que las de Spotify). */
export function songToTrack(s: Song): Track {
  return { id: s.id, uri: `${LOCAL_URI_PREFIX}${s.id}`, name: s.title, artists: s.artist, album: s.album, durationMs: s.durationMs, image: null };
}

/** SHA-256 del archivo, para deduplicar en el servidor antes de subir. */
export async function fileHash(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Duración leída por el navegador (sin dependencias). */
export function readDuration(file: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = new Audio();
    const done = (ms: number) => {
      URL.revokeObjectURL(url);
      resolve(ms);
    };
    el.preload = 'metadata';
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : 0);
    el.onerror = () => done(0);
    el.src = url;
  });
}

/** "Artista - Título.mp3" → { artist, title }; si no hay guion, todo es el título. */
export function parseFileName(name: string): { title: string; artist: string } {
  const base = name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/^\d{1,3}[\s.-]+/, '').trim();
  const m = base.match(/^(.+?)\s+-\s+(.+)$/);
  return m && m[1] && m[2] ? { artist: m[1].trim(), title: m[2].trim() } : { title: base, artist: '' };
}

export interface UploadProgress {
  stage: 'hash' | 'duration' | 'announce' | 'upload' | 'done' | 'duplicate';
  percent?: number;
}

/** Sube un archivo: hash → anuncio (deduplica) → bytes con progreso. Devuelve la canción (nueva o ya existente). */
export async function uploadSong(file: File, meta: { title: string; artist: string; album?: string }, onProgress: (p: UploadProgress) => void = () => undefined): Promise<{ song: Song; duplicate: boolean }> {
  const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  onProgress({ stage: 'hash' });
  const hash = await fileHash(file);
  onProgress({ stage: 'duration' });
  const durationMs = await readDuration(file);
  onProgress({ stage: 'announce' });
  const announced = await libraryApi.announce({ hash, ext, size: file.size, title: meta.title, artist: meta.artist, album: meta.album ?? '', durationMs });
  if (announced.duplicate || announced.song.status === 'READY') {
    onProgress({ stage: 'duplicate' });
    return announced;
  }
  onProgress({ stage: 'upload', percent: 0 });
  const result = await new Promise<{ song: Song; duplicate: boolean }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', songUrl(announced.song.id));
    xhr.setRequestHeader('Authorization', `Bearer ${token()}`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) onProgress({ stage: 'upload', percent: Math.round((ev.loaded / ev.total) * 100) });
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText) as { song?: Song; duplicate?: boolean; error?: string; message?: string };
        if (xhr.status >= 200 && xhr.status < 300 && data.song) resolve({ song: data.song, duplicate: !!data.duplicate });
        else reject(new ApiError(xhr.status, data.error ?? 'upload', data.message ?? `HTTP ${xhr.status}`));
      } catch {
        reject(new ApiError(xhr.status, 'upload', `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Se perdió la conexión durante la subida'));
    xhr.send(file);
  });
  onProgress({ stage: 'done', percent: 100 });
  return result;
}
