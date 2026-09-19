import assert from 'node:assert/strict';
import { test } from 'node:test';

import { autoMarkedCells, buildSyncState, parseSyncState, type SyncState } from '../src/sync.js';
import type { GameState } from '../src/store.js';

const state: SyncState = { v: 1, seed: 'ABC123', called: [5, 9, 2], revealed: false, now: null, autoMark: 'played', t: 1000 };

test('parseSyncState acepta estados válidos y rechaza el resto', () => {
  assert.deepEqual(parseSyncState(JSON.stringify(state)), { ...state, log: [], msg: null, cur: null, play: null });
  assert.equal(parseSyncState('no es json'), null);
  assert.equal(parseSyncState(JSON.stringify({ v: 2 })), null);
  assert.equal(parseSyncState(JSON.stringify({ v: 1, seed: 'X', called: 'nope' })), null);
  const parsed = parseSyncState(JSON.stringify({ v: 1, seed: 'X', called: [1, 'x', 2], autoMark: 'raro' }));
  assert.deepEqual(parsed?.called, [1, 2]);
  assert.equal(parsed?.autoMark, 'played');
});

test('autoMarkedCells marca según el modo', () => {
  const cells = [5, null, 2, 7, 9];
  assert.deepEqual(autoMarkedCells(cells, state), [true, false, true, false, true]);
  assert.deepEqual(autoMarkedCells(cells, { ...state, autoMark: 'off' }), [false, false, false, false, false]);
  // Al revelar: la última cantada (2) no cuenta hasta que se revele
  assert.deepEqual(autoMarkedCells(cells, { ...state, autoMark: 'revealed' }), [true, false, false, false, true]);
  assert.deepEqual(autoMarkedCells(cells, { ...state, autoMark: 'revealed', revealed: true }), [true, false, true, false, true]);
  assert.deepEqual(autoMarkedCells(cells, null), [false, false, false, false, false]);
});

test('buildSyncState incluye el historial revelado y el mensaje', () => {
  const tracks = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, uri: `spotify:track:t${i}`, name: `Tema ${i}`, artists: `Grupo ${i}`, album: '', durationMs: 1000, image: null }));
  const game: GameState = {
    version: 1, createdAt: 0, playlistName: 'x', tracks, order: tracks.map((_, i) => i), position: 3, revealed: false,
    config: { seed: 'S', gridSize: 3, freeCenter: false, cardCount: 1, snippetSeconds: 10, startMode: 'start' },
    message: 'Pausa', messageAt: 5,
  };
  let state = buildSyncState(game);
  assert.deepEqual(state.called, [0, 1, 2]);
  assert.deepEqual(state.log, [[1, 'Tema 0', 'Grupo 0'], [2, 'Tema 1', 'Grupo 1']], 'la última no está revelada');
  assert.equal(state.now, null);
  assert.deepEqual(state.msg, { text: 'Pausa', t: 5 });
  game.revealed = true;
  state = buildSyncState(game);
  assert.equal(state.log?.length, 3);
  assert.deepEqual(state.now, { name: 'Tema 2', artists: 'Grupo 2' });
  game.position = 20;
  state = buildSyncState(game);
  assert.equal(state.log?.length, 12, 'se limita el historial');
  assert.deepEqual(state.log?.[11], [20, 'Tema 19', 'Grupo 19']);
  assert.ok(JSON.stringify(state).length < 2000, 'mensaje pequeño');
  const round = parseSyncState(JSON.stringify(state));
  assert.deepEqual(round?.log, state.log);
  assert.deepEqual(round?.msg, state.msg);
  assert.deepEqual(round?.cur, { id: 't19', name: 'Tema 19', artists: 'Grupo 19', album: '', durationMs: 1000 }, 'canción en curso para la letra');
  game.config.lyrics = false;
  assert.equal(buildSyncState(game).cur, null, 'sin letras no se envía la canción en curso');
});
