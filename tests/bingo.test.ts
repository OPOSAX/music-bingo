import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GameConfig } from '../src/bingo.js';
import { cardLabel, cellCount, evaluateCard, evaluateMarks, generateCard, generateCards, playOrder, validateConfig, winningLines } from '../src/bingo.js';
import { hashString, mulberry32, shuffle } from '../src/rng.js';

const config: GameConfig = { seed: 'ABC123', gridSize: 5, freeCenter: true, cardCount: 10, snippetSeconds: 20, startMode: 'random' };

test('el generador es determinista', () => {
  const a = mulberry32(hashString('hola'));
  const b = mulberry32(hashString('hola'));
  for (let i = 0; i < 20; i++) assert.equal(a(), b());
  const c = mulberry32(hashString('adios'));
  assert.notEqual(a(), c());
});

test('shuffle devuelve una permutación', () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const out = shuffle(items, mulberry32(42));
  assert.deepEqual([...out].sort((x, y) => x - y), items);
  assert.deepEqual(items, [1, 2, 3, 4, 5, 6, 7, 8], 'no modifica el original');
});

test('cellCount tiene en cuenta la casilla libre', () => {
  assert.equal(cellCount(5, true), 24);
  assert.equal(cellCount(5, false), 25);
  assert.equal(cellCount(4, true), 16, 'sin centro en tamaños pares');
  assert.equal(cellCount(3, true), 8);
});

test('generateCard es determinista y sin repeticiones', () => {
  const card = generateCard(config, 60, 3);
  const again = generateCard(config, 60, 3);
  assert.deepEqual(card, again);
  assert.equal(card.cells.length, 25);
  assert.equal(card.cells[12], null, 'centro libre');
  const values = card.cells.filter((c): c is number => c !== null);
  assert.equal(new Set(values).size, 24);
  assert.ok(values.every((v) => v >= 0 && v < 60));
  const other = generateCard(config, 60, 4);
  assert.notDeepEqual(card.cells, other.cells);
});

test('generateCards genera cardCount tarjetas distintas', () => {
  const cards = generateCards({ ...config, cardCount: 50 }, 40);
  assert.equal(cards.length, 50);
  const keys = new Set(cards.map((c) => c.cells.join(',')));
  assert.equal(keys.size, 50);
});

test('generateCard rellena con casillas libres si faltan canciones', () => {
  const card = generateCard(config, 10, 0);
  assert.equal(card.cells.length, 25);
  const songs = card.cells.filter((c): c is number => c !== null);
  assert.equal(songs.length, 10, 'usa todas las canciones disponibles');
  assert.equal(new Set(songs).size, 10, 'sin repetir');
  assert.equal(card.cells.filter((c) => c === null).length, 15, '14 libres más el centro');
  assert.deepEqual(generateCard(config, 10, 0), card, 'determinista');
  assert.notDeepEqual(generateCard(config, 10, 1).cells, card.cells, 'las libres cambian de sitio entre tarjetas');
  assert.throws(() => generateCard(config, 0, 0));
});

test('playOrder es una permutación determinista del pool', () => {
  const order = playOrder(config, 30);
  assert.deepEqual([...order].sort((a, b) => a - b), Array.from({ length: 30 }, (_, i) => i));
  assert.deepEqual(order, playOrder(config, 30));
});

test('winningLines cuenta filas, columnas y diagonales', () => {
  assert.equal(winningLines(3).length, 8);
  assert.equal(winningLines(5).length, 12);
  assert.deepEqual(winningLines(3)[6], [0, 4, 8]);
  assert.deepEqual(winningLines(3)[7], [2, 4, 6]);
});

test('evaluateCard detecta línea y bingo', () => {
  const card = generateCard(config, 60, 0);
  assert.equal(evaluateCard(card, new Set()).status, 'none');
  const firstRow = card.cells.slice(0, 5).filter((c): c is number => c !== null);
  const line = evaluateCard(card, new Set(firstRow));
  assert.equal(line.status, 'line');
  assert.deepEqual(line.completedLines[0], [0, 1, 2, 3, 4]);
  const middleRow = card.cells.slice(10, 15).filter((c): c is number => c !== null);
  assert.equal(evaluateCard(card, new Set(middleRow)).status, 'line', 'la casilla libre completa la fila central');
  const all = card.cells.filter((c): c is number => c !== null);
  const full = evaluateCard(card, new Set(all));
  assert.equal(full.status, 'full');
  assert.equal(full.remaining, 0);
  assert.equal(full.completedLines.length, 12);
});

test('evaluateMarks respeta las marcas del jugador', () => {
  const card = generateCard({ ...config, gridSize: 3, freeCenter: false }, 20, 0);
  const marks = [true, false, false, false, true, false, false, false, true];
  const ev = evaluateMarks(card, marks);
  assert.equal(ev.status, 'line');
  assert.deepEqual(ev.completedLines, [[0, 4, 8]]);
  assert.equal(ev.remaining, 6);
});

test('validateConfig informa de errores', () => {
  assert.deepEqual(validateConfig(config, 60), []);
  assert.deepEqual(validateConfig(config, 10), [], 'menos canciones que casillas ya no es un error');
  assert.ok(validateConfig(config, 0).length > 0);
  assert.ok(validateConfig({ ...config, cardCount: 0 }, 60).length > 0);
  assert.ok(validateConfig({ ...config, snippetSeconds: 1 }, 60).length > 0);
});

test('cardLabel', () => {
  assert.equal(cardLabel('ABC123', 0), 'ABC123-1');
});
