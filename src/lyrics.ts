/**
 * Letras de canciones a través de LRCLIB (https://lrclib.net), base de datos abierta y gratuita.
 * Devuelve letra sincronizada (LRC) cuando existe, o letra plana.
 */

export interface LyricLine {
  /** Milisegundos desde el inicio de la canción. */
  t: number;
  text: string;
}

export interface Lyrics {
  plain: string;
  synced: LyricLine[];
  source: string;
}

export interface LyricsQuery {
  id: string;
  name: string;
  artists: string;
  album?: string;
  durationMs?: number;
}

const LRCLIB = 'https://lrclib.net/api';
const CACHE_PREFIX = 'musicbingo:lyrics:';
const memory = new Map<string, Lyrics | null>();

interface LrclibRecord {
  id?: number;
  trackName?: string;
  artistName?: string;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
  instrumental?: boolean;
}

/** Convierte un texto LRC ("[mm:ss.xx] letra") en líneas con tiempo. */
export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const match = raw.match(/^\s*((?:\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]\s*)+)(.*)$/);
    if (!match) continue;
    const text = (match[2] ?? '').trim();
    const stamps = match[1]?.match(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g) ?? [];
    for (const stamp of stamps) {
      const parts = stamp.match(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/);
      if (!parts) continue;
      const minutes = Number(parts[1]);
      const seconds = Number(parts[2]);
      const fraction = parts[3] ? Number(`0.${parts[3]}`) : 0;
      lines.push({ t: Math.round((minutes * 60 + seconds + fraction) * 1000), text });
    }
  }
  return lines.sort((a, b) => a.t - b.t);
}

/** Índice de la línea que corresponde a un instante (o -1 si aún no ha empezado la letra). */
export function currentLineIndex(lines: readonly LyricLine[], positionMs: number): number {
  let index = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] as LyricLine).t <= positionMs) index = i;
    else break;
  }
  return index;
}

function fromRecord(record: LrclibRecord): Lyrics | null {
  if (record.instrumental) return { plain: '(Instrumental)', synced: [], source: 'LRCLIB' };
  const synced = record.syncedLyrics ? parseLrc(record.syncedLyrics) : [];
  const plain = (record.plainLyrics ?? '').trim() || synced.map((l) => l.text).join('\n');
  if (!plain) return null;
  return { plain, synced, source: 'LRCLIB' };
}

function primaryArtist(artists: string): string {
  return artists.split(/,|&| feat\.? | ft\.? /i)[0]?.trim() ?? artists;
}

function cleanTitle(name: string): string {
  return name.replace(/\s*[-(\[].*?(remaster|version|edit|live|mix|feat\.?|ft\.?|bonus|deluxe|mono|stereo).*$/i, '').trim() || name;
}

/** Último problema de red al consultar letras (para mostrarlo en pantalla). */
export let lastLyricsError: string | null = null;

async function getJson<T>(url: string): Promise<T | null> {
  try {
    // Sin cabeceras personalizadas: así la petición no necesita "preflight" CORS.
    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) {
      lastLyricsError = `LRCLIB respondió ${res.status}`;
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    lastLyricsError = `sin acceso a LRCLIB (${err instanceof Error ? err.message : String(err)})`;
    return null;
  }
}

/** Fuente alternativa con solo letra plana (lyrics.ovh). */
async function fetchFromLyricsOvh(artist: string, title: string): Promise<Lyrics | null> {
  try {
    const res = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { lyrics?: string };
    const plain = (data.lyrics ?? '').trim();
    return plain ? { plain, synced: [], source: 'lyrics.ovh' } : null;
  } catch {
    return null;
  }
}

/** Busca la letra; devuelve null si no se encuentra. Los resultados se guardan en caché. */
export async function fetchLyrics(query: LyricsQuery): Promise<Lyrics | null> {
  const key = `${CACHE_PREFIX}${query.id}`;
  if (memory.get(key)) return memory.get(key) as Lyrics;
  try {
    const cached = localStorage.getItem(key);
    if (cached && cached !== 'null') {
      const parsed = JSON.parse(cached) as Lyrics;
      memory.set(key, parsed);
      return parsed;
    }
  } catch {
    /* sin caché */
  }

  const artist = primaryArtist(query.artists);
  const candidates: (() => Promise<LrclibRecord | LrclibRecord[] | null>)[] = [];
  if (query.durationMs) {
    const params = new URLSearchParams({ track_name: query.name, artist_name: artist, duration: String(Math.round(query.durationMs / 1000)) });
    if (query.album) params.set('album_name', query.album);
    candidates.push(() => getJson<LrclibRecord>(`${LRCLIB}/get?${params}`));
  }
  candidates.push(() => getJson<LrclibRecord[]>(`${LRCLIB}/search?${new URLSearchParams({ track_name: cleanTitle(query.name), artist_name: artist })}`));
  candidates.push(() => getJson<LrclibRecord[]>(`${LRCLIB}/search?${new URLSearchParams({ q: `${cleanTitle(query.name)} ${artist}` })}`));

  lastLyricsError = null;
  let result: Lyrics | null = null;
  for (const candidate of candidates) {
    const data = await candidate();
    if (!data) continue;
    const records = Array.isArray(data) ? data : [data];
    const best = records.find((r) => r.syncedLyrics) ?? records.find((r) => r.plainLyrics) ?? records[0];
    if (best) result = fromRecord(best);
    if (result) break;
  }
  if (!result) result = await fetchFromLyricsOvh(artist, cleanTitle(query.name));

  // Solo se guardan en caché los aciertos: un fallo de red no debe quedarse fijo.
  if (result) {
    memory.set(key, result);
    try {
      localStorage.setItem(key, JSON.stringify(result));
    } catch {
      /* almacenamiento lleno: no pasa nada */
    }
  }
  return result;
}
