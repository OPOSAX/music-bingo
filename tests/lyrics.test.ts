import assert from 'node:assert/strict';
import { test } from 'node:test';

import { currentLineIndex, parseLrc } from '../src/lyrics.js';

test('parseLrc convierte marcas de tiempo y ordena', () => {
  const lines = parseLrc('[00:12.50] Hola\n[00:05.00]Primera\n[ar:autor]\n[01:00.1] Minuto\n\n[00:20.00][00:30.00] Repetida');
  assert.deepEqual(lines, [
    { t: 5000, text: 'Primera' },
    { t: 12500, text: 'Hola' },
    { t: 20000, text: 'Repetida' },
    { t: 30000, text: 'Repetida' },
    { t: 60100, text: 'Minuto' },
  ]);
});

test('currentLineIndex devuelve la línea vigente', () => {
  const lines = parseLrc('[00:05.00]A\n[00:10.00]B\n[00:15.00]C');
  assert.equal(currentLineIndex(lines, 0), -1);
  assert.equal(currentLineIndex(lines, 5000), 0);
  assert.equal(currentLineIndex(lines, 12000), 1);
  assert.equal(currentLineIndex(lines, 99000), 2);
});
