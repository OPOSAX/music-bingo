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
