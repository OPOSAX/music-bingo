import assert from 'node:assert/strict';
import { test } from 'node:test';

import { autoMarkedCells, parseSyncState, type SyncState } from '../src/sync.js';

const state: SyncState = { v: 1, seed: 'ABC123', called: [5, 9, 2], revealed: false, now: null, autoMark: 'played', t: 1000 };

test('parseSyncState acepta estados válidos y rechaza el resto', () => {
  assert.deepEqual(parseSyncState(JSON.stringify(state)), state);
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
