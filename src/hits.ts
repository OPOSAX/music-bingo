/**
 * Generador de listas de éxitos a partir de la búsqueda de Spotify:
 * idioma, épocas y géneros se convierten en consultas y los resultados se combinan.
 */

import type { Track } from './bingo.js';

export type Language = 'es' | 'en' | 'both';

export interface Decade {
  id: string;
  label: string;
  from: number;
  to: number;
}

export const DECADES: Decade[] = [
  { id: '60', label: 'Años 60', from: 1960, to: 1969 },
  { id: '70', label: 'Años 70', from: 1970, to: 1979 },
  { id: '80', label: 'Años 80', from: 1980, to: 1989 },
  { id: '90', label: 'Años 90', from: 1990, to: 1999 },
  { id: '00', label: 'Años 2000', from: 2000, to: 2009 },
  { id: '10', label: 'Años 2010', from: 2010, to: 2019 },
  { id: '20', label: 'Años 2020', from: 2020, to: 2029 },
];

export interface Genre {
  id: string;
  label: string;
  /** Términos de búsqueda por idioma (se usan como filtro genre: o como texto libre). */
  es: string[];
  en: string[];
}

export const GENRES: Genre[] = [
  { id: 'pop', label: 'Pop', es: ['genre:"latin pop"', 'genre:"spanish pop"', 'pop español'], en: ['genre:pop', 'genre:"dance pop"'] },
  { id: 'rock', label: 'Rock', es: ['genre:"rock en espanol"', 'genre:"latin rock"', 'rock español'], en: ['genre:rock', 'genre:"classic rock"'] },
  { id: 'rap', label: 'Rap / Hip hop', es: ['genre:"latin hip hop"', 'genre:"spanish hip hop"', 'rap español'], en: ['genre:"hip hop"', 'genre:rap'] },
  { id: 'romantic', label: 'Romántico / Baladas', es: ['genre:balada', 'balada romántica', 'genre:bolero'], en: ['genre:"soft rock"', 'love ballad', 'genre:"adult standards"'] },
  { id: 'latin', label: 'Reggaeton / Latino', es: ['genre:reggaeton', 'genre:"latin"', 'genre:"urbano latino"'], en: ['genre:reggaeton', 'genre:"latin"'] },
  { id: 'dance', label: 'Electrónica / Dance', es: ['genre:"latin edm"', 'electrónica', 'genre:edm'], en: ['genre:edm', 'genre:dance', 'genre:house'] },
  { id: 'tropical', label: 'Salsa / Cumbia / Bachata', es: ['genre:salsa', 'genre:cumbia', 'genre:bachata', 'genre:merengue'], en: ['genre:salsa', 'genre:bachata'] },
  { id: 'disco', label: 'Disco / Funk', es: ['genre:disco', 'genre:funk'], en: ['genre:disco', 'genre:funk', 'genre:soul'] },
  { id: 'metal', label: 'Metal', es: ['genre:"spanish metal"', 'genre:metal'], en: ['genre:metal', 'genre:"heavy metal"'] },
  { id: 'indie', label: 'Indie / Alternativo', es: ['genre:"spanish indie"', 'genre:"indie latino"'], en: ['genre:indie', 'genre:"alternative rock"'] },
  { id: 'rnb', label: 'R&B / Soul', es: ['genre:"latin r&b"', 'genre:soul'], en: ['genre:"r&b"', 'genre:soul'] },
  { id: 'country', label: 'Country / Folk', es: ['genre:"latin folk"', 'genre:ranchera'], en: ['genre:country', 'genre:folk'] },
];

export interface HitsOptions {
  language: Language;
  decades: string[];
  genres: string[];
  count: number;
}

export interface HitsQuery {
  q: string;
  /** Mercado de Spotify que ayuda a orientar el idioma de los resultados. */
  market: string;
  label: string;
}

const MARKETS: Record<Exclude<Language, 'both'>, string[]> = { es: ['ES', 'MX', 'AR'], en: ['US', 'GB'] };

/** Construye las consultas de búsqueda para las opciones elegidas. */
export function buildQueries(options: HitsOptions): HitsQuery[] {
  const languages: Exclude<Language, 'both'>[] = options.language === 'both' ? ['es', 'en'] : [options.language];
  const decades = DECADES.filter((d) => options.decades.includes(d.id));
  const genres = GENRES.filter((g) => options.genres.includes(g.id));
  const queries: HitsQuery[] = [];
  const yearFilters = decades.length ? decades.map((d) => ({ label: d.label, filter: ` year:${d.from}-${d.to}` })) : [{ label: '', filter: '' }];
  for (const lang of languages) {
    const terms = genres.length ? genres.flatMap((g) => g[lang].map((t) => ({ term: t, label: g.label }))) : lang === 'es' ? [{ term: 'genre:"latin pop"', label: 'Pop' }, { term: 'genre:"rock en espanol"', label: 'Rock' }, { term: 'genre:reggaeton', label: 'Latino' }, { term: 'genre:balada', label: 'Baladas' }] : [{ term: 'genre:pop', label: 'Pop' }, { term: 'genre:rock', label: 'Rock' }, { term: 'genre:"hip hop"', label: 'Hip hop' }, { term: 'genre:dance', label: 'Dance' }];
    const markets = MARKETS[lang];
    terms.forEach(({ term, label }, i) => {
      for (const year of yearFilters) {
        queries.push({ q: `${term}${year.filter}`, market: markets[i % markets.length] as string, label: [label, year.label].filter(Boolean).join(' ') });
      }
    });
  }
  return queries;
}

function key(track: Track): string {
  return `${track.name.toLowerCase().replace(/\s*[-(\[].*$/, '').trim()}|${track.artists.toLowerCase().split(',')[0]?.trim() ?? ''}`;
}

/**
 * Combina los resultados de varias consultas: reparte por igual entre consultas, ordena cada
 * una por popularidad, evita repetidos y limita el número de canciones por artista.
 */
export function pickTracks(results: Track[][], count: number, maxPerArtist = 3): Track[] {
  const sorted = results.map((list) => [...list].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0)));
  const seen = new Set<string>();
  const perArtist = new Map<string, number>();
  const out: Track[] = [];
  let progress = true;
  while (out.length < count && progress) {
    progress = false;
    for (const list of sorted) {
      while (list.length > 0) {
        const track = list.shift() as Track;
        const k = key(track);
        const artist = track.artists.toLowerCase().split(',')[0]?.trim() ?? '';
        if (seen.has(k) || seen.has(track.id) || (perArtist.get(artist) ?? 0) >= maxPerArtist) continue;
        seen.add(k);
        seen.add(track.id);
        perArtist.set(artist, (perArtist.get(artist) ?? 0) + 1);
        out.push(track);
        progress = true;
        break;
      }
      if (out.length >= count) break;
    }
  }
  return out;
}

/** Nombre descriptivo para la lista generada. */
export function describeOptions(options: HitsOptions): string {
  const lang = options.language === 'es' ? 'en español' : options.language === 'en' ? 'en inglés' : 'español e inglés';
  const decades = DECADES.filter((d) => options.decades.includes(d.id)).map((d) => d.label.replace('Años ', ''));
  const genres = GENRES.filter((g) => options.genres.includes(g.id)).map((g) => g.label);
  const parts = ['Éxitos', lang];
  if (genres.length) parts.push(genres.join(', '));
  if (decades.length) parts.push(`años ${decades.join('/')}`);
  return parts.join(' · ');
}
