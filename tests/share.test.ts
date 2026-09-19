import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeSharedCard, encodeSharedCard, type SharedCard } from '../src/share.js';

const card: SharedCard = {
  v: 1,
  g: 'ABC123',
  n: 4,
  s: 3,
  t: 'Fiesta 90s',
  c: [['Wannabe', 'Spice Girls'], ['Ñandú ✨', 'Banda'], null, ['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h'], ['i', 'j'], ['k', 'l']],
};

test('codifica y decodifica una tarjeta (comprimida)', async () => {
  const text = await encodeSharedCard(card);
  assert.match(text, /^[zj][A-Za-z0-9_-]+$/, 'apto para URL');
  assert.deepEqual(await decodeSharedCard(text), card);
});

test('rechaza enlaces corruptos', async () => {
  await assert.rejects(decodeSharedCard('xabc'));
  await assert.rejects(decodeSharedCard('j' + btoa('{"v":2}').replace(/=+$/, '')));
});

test('codifica y decodifica el QR único de la partida', async () => {
  const { decodeJoinPayload, encodeJoinPayload } = await import('../src/share.js');
  const join = { v: 1 as const, g: 'ABC123', s: 5 as const, f: true, n: 20, p: 79, y: 'mbingo-abc123-00ff', t: 'Fiesta' };
  const text = await encodeJoinPayload(join);
  assert.ok(text.length < 160, `el QR único debe ser pequeño (${text.length})`);
  assert.deepEqual(await decodeJoinPayload(text), join);
  await assert.rejects(decodeJoinPayload('j' + btoa('{"v":1}').replace(/=+$/, '')));
});
