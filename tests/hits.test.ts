import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Track } from '../src/bingo.js';
import { buildQueries, describeOptions, pickTracks } from '../src/hits.js';

const t = (id: string, name: string, artists: string, popularity: number): Track => ({ id, uri: `spotify:track:${id}`, name, artists, album: '', durationMs: 1000, image: null, popularity });

test('buildQueries combina idioma, épocas y géneros', () => {
  const qs = buildQueries({ language: 'es', decades: ['80', '90'], genres: ['rock'], count: 50 });
  assert.equal(qs.length, 3 * 2, 'tres términos de rock en español por dos épocas');
  assert.ok(qs.every((q) => /year:19[89]0-19[89]9/.test(q.q)));
  assert.ok(qs.some((q) => q.q.includes('rock en espanol')));
  assert.ok(qs.every((q) => ['ES', 'MX', 'AR'].includes(q.market)));
  const both = buildQueries({ language: 'both', decades: [], genres: ['pop'], count: 50 });
  assert.ok(both.some((q) => q.market === 'US') && both.some((q) => q.market === 'ES'));
  assert.ok(both.every((q) => !q.q.includes('year:')), 'sin épocas no hay filtro de año');
  const none = buildQueries({ language: 'en', decades: ['00'], genres: [], count: 50 });
  assert.ok(none.length >= 4, 'sin géneros se usan varios géneros generales');
});

test('pickTracks reparte entre consultas, ordena por popularidad y limita por artista', () => {
  const a = [t('a1', 'Uno', 'Artista A', 50), t('a2', 'Dos', 'Artista A', 90), t('a3', 'Tres', 'Artista A', 80), t('a4', 'Cuatro', 'Artista A', 70), t('a5', 'Cinco', 'Artista B', 10)];
  const b = [t('b1', 'Seis', 'Artista C', 60), t('a2', 'Dos', 'Artista A', 90), t('b2', 'Dos (Remastered)', 'Artista A', 95)];
  const picked = pickTracks([a, b], 6);
  assert.deepEqual(picked.map((x) => x.id), ['a2', 'b1', 'a3', 'a4', 'a5']);
  assert.ok(!picked.some((x) => x.id === 'b2'), 'el remaster de "Dos" cuenta como repetido');
  assert.equal(picked.filter((x) => x.artists === 'Artista A').length, 3, 'máximo tres por artista');
  assert.equal(pickTracks([a], 2).length, 2);
});

test('describeOptions genera un nombre legible', () => {
  assert.equal(describeOptions({ language: 'es', decades: ['80', '90'], genres: ['rock', 'pop'], count: 50 }), 'Éxitos · en español · Pop, Rock · años 80/90');
  assert.equal(describeOptions({ language: 'both', decades: [], genres: [], count: 50 }), 'Éxitos · español e inglés');
});
