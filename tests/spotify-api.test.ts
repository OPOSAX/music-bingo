import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Track } from '../src/bingo.js';
import { snippetStart } from '../src/player.js';
import { dedupeTracks, parsePlaylistInput } from '../src/spotify-api.js';

test('parsePlaylistInput reconoce URL, URI e ID', () => {
  assert.equal(parsePlaylistInput('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc'), '37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(parsePlaylistInput('https://open.spotify.com/intl-es/playlist/37i9dQZF1DXcBWIGoYBM5M'), '37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(parsePlaylistInput('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'), '37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(parsePlaylistInput('  37i9dQZF1DXcBWIGoYBM5M '), '37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(parsePlaylistInput('https://open.spotify.com/album/xyz'), null);
  assert.equal(parsePlaylistInput(''), null);
});

const track = (id: string, name: string, artists: string): Track => ({ id, uri: `spotify:track:${id}`, name, artists, album: '', durationMs: 200_000, image: null });

test('dedupeTracks elimina duplicados por id y por título+artista', () => {
  const out = dedupeTracks([track('1', 'A', 'X'), track('1', 'A', 'X'), track('2', 'a ', 'x'), track('3', 'B', 'X')]);
  assert.deepEqual(out.map((t) => t.id), ['1', '3']);
});

test('snippetStart respeta los modos y no se sale de la canción', () => {
  const t = track('1', 'A', 'X');
  assert.equal(snippetStart(t, 'start', 20), 0);
  const middle = snippetStart(t, 'middle', 20);
  assert.ok(middle > 0 && middle + 20_000 <= t.durationMs);
  for (let i = 0; i < 50; i++) {
    const r = snippetStart(t, 'random', 20);
    assert.ok(r >= 0 && r + 20_000 <= t.durationMs, `inicio ${r} fuera de rango`);
  }
  const short: Track = { ...t, durationMs: 15_000 };
  assert.equal(snippetStart(short, 'random', 20), 0, 'canción más corta que el fragmento');
});
