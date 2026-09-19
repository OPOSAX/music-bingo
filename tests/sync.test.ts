import assert from 'node:assert/strict';
import { test } from 'node:test';

import { autoMarkedCells, buildSyncState, parseSyncState, type SyncState } from '../src/sync.js';
import type { GameState } from '../src/store.js';

const state: SyncState = { v: 1, seed: 'ABC123', called: [5, 9, 2], revealed: false, now: null, autoMark: 'played', t: 1000 };

test('parseSyncState acepta estados válidos y rechaza el resto', () => {
  assert.deepEqual(parseSyncState(JSON.stringify(state)), { ...state, log: [], msg: null, cur: null, play: null, claims: {} });
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

test('poolChunks y assemblePool reparten y recomponen la lista', async () => {
  const { assemblePool, nextFreeIndex, parseSyncMessage, poolChunks } = await import('../src/sync.js');
  const items = Array.from({ length: 200 }, (_, i) => [`Canción número ${i} con un título bastante largo`, `Artista ${i}`] as [string, string]);
  const chunks = poolChunks('S', items);
  assert.ok(chunks.length > 1, 'se trocea');
  assert.ok(chunks.every((c) => JSON.stringify(c).length < 3400), 'cada trozo cabe en un mensaje');
  assert.equal(chunks[0]?.from, 0);
  assert.equal(chunks[1]?.from, chunks[0]?.items.length);
  const map = new Map(chunks.map((c) => [c.i, c]));
  assert.deepEqual(assemblePool(map, items.length), items);
  map.delete(1);
  assert.equal(assemblePool(map, items.length), null, 'falta un trozo');
  assert.equal(poolChunks('S', []).length, 1, 'lista vacía: un trozo vacío');

  const claims = { '0': { n: 'Ana', c: 'a' }, '1': { n: 'Luis', c: 'b' }, '3': { n: 'Eva', c: 'c' } };
  assert.equal(nextFreeIndex(claims, 5, 'z'), 2);
  assert.equal(nextFreeIndex(claims, 5, 'z', 2), 4);
  assert.equal(nextFreeIndex(claims, 5, 'z', 4), null);
  assert.equal(nextFreeIndex(claims, 5, 'b'), 1, 'su propia tarjeta cuenta como libre para él');
  assert.equal(nextFreeIndex(undefined, 3, 'z'), 0);

  const claim = parseSyncMessage(JSON.stringify({ k: 'claim', seed: 'S', index: 2, name: 'Ana', cid: 'a', t: 5 }));
  assert.deepEqual(claim, { k: 'claim', seed: 'S', index: 2, name: 'Ana', cid: 'a', t: 5 });
  assert.equal(parseSyncMessage(JSON.stringify({ k: 'claim', seed: 'S' })), null);
  const pool = parseSyncMessage(JSON.stringify(chunks[0]));
  assert.equal(pool?.k, 'pool');
  const st = parseSyncMessage(JSON.stringify(state));
  assert.equal(st?.k, 'state');
});
