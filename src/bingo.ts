/** Lógica pura del bingo: generación de tarjetas y detección de líneas/bingo. */

import { rngFromString, shuffle } from './rng.js';

export interface Track {
  id: string;
  uri: string;
  name: string;
  artists: string;
  album: string;
  durationMs: number;
  image: string | null;
}

export type GridSize = 3 | 4 | 5;
export type StartMode = 'start' | 'random' | 'middle';

export interface GameConfig {
  /** Código de la partida; junto con el índice determina cada tarjeta. */
  seed: string;
  gridSize: GridSize;
  /** Casilla central libre (solo tiene sentido con tamaño impar). */
  freeCenter: boolean;
  cardCount: number;
  /** Duración del fragmento que se reproduce en cada turno. */
  snippetSeconds: number;
  startMode: StartMode;
}

/** Celda de una tarjeta: índice dentro del pool de canciones o null si es libre. */
export type Cell = number | null;

export interface Card {
  /** Índice de la tarjeta dentro de la partida (0-based). */
  index: number;
  gridSize: GridSize;
  cells: Cell[];
}

export type CardStatus = 'none' | 'line' | 'full';

export interface CardEvaluation {
  marked: boolean[];
  /** Índices de celda de cada línea completada. */
  completedLines: number[][];
  status: CardStatus;
  /** Cuántas casillas faltan para completar la tarjeta. */
  remaining: number;
}

export function cellCount(gridSize: GridSize, freeCenter: boolean): number {
  return gridSize * gridSize - (hasFreeCenter(gridSize, freeCenter) ? 1 : 0);
}

export function hasFreeCenter(gridSize: GridSize, freeCenter: boolean): boolean {
  return freeCenter && gridSize % 2 === 1;
}

export function centerIndex(gridSize: GridSize): number {
  return Math.floor((gridSize * gridSize) / 2);
}

/** Número mínimo de canciones recomendado para que las tarjetas sean variadas. */
export function recommendedPoolSize(gridSize: GridSize, freeCenter: boolean): number {
  return Math.max(cellCount(gridSize, freeCenter) * 2, 20);
}

export function validateConfig(config: GameConfig, poolSize: number): string[] {
  const errors: string[] = [];
  if (![3, 4, 5].includes(config.gridSize)) errors.push('El tamaño de la tarjeta debe ser 3, 4 o 5.');
  if (!Number.isInteger(config.cardCount) || config.cardCount < 1 || config.cardCount > 500) {
    errors.push('El número de tarjetas debe estar entre 1 y 500.');
  }
  if (!(config.snippetSeconds >= 3 && config.snippetSeconds <= 120)) {
    errors.push('La duración del fragmento debe estar entre 3 y 120 segundos.');
  }
  if (!config.seed) errors.push('Falta el código de partida.');
  const needed = cellCount(config.gridSize, config.freeCenter);
  if (poolSize < needed) {
    errors.push(`La lista necesita al menos ${needed} canciones distintas (tiene ${poolSize}).`);
  }
  return errors;
}

/** Genera la tarjeta `index` de forma determinista a partir de la semilla. */
export function generateCard(config: GameConfig, poolSize: number, index: number): Card {
  const { gridSize } = config;
  const needed = cellCount(gridSize, config.freeCenter);
  if (poolSize < needed) throw new Error('No hay suficientes canciones para generar una tarjeta.');
  const rand = rngFromString(`${config.seed}:card:${index}`);
  const indices = Array.from({ length: poolSize }, (_, i) => i);
  const chosen = shuffle(indices, rand).slice(0, needed);
  const cells: Cell[] = [];
  const free = hasFreeCenter(gridSize, config.freeCenter) ? centerIndex(gridSize) : -1;
  let k = 0;
  for (let i = 0; i < gridSize * gridSize; i++) {
    if (i === free) cells.push(null);
    else cells.push(chosen[k++] as number);
  }
  return { index, gridSize, cells };
}

export function generateCards(config: GameConfig, poolSize: number): Card[] {
  return Array.from({ length: config.cardCount }, (_, i) => generateCard(config, poolSize, i));
}

/** Orden de reproducción determinista de todo el pool. */
export function playOrder(config: GameConfig, poolSize: number): number[] {
  const rand = rngFromString(`${config.seed}:order`);
  return shuffle(Array.from({ length: poolSize }, (_, i) => i), rand);
}

/** Todas las líneas ganadoras (filas, columnas y diagonales) como índices de celda. */
export function winningLines(gridSize: GridSize): number[][] {
  const lines: number[][] = [];
  for (let r = 0; r < gridSize; r++) lines.push(Array.from({ length: gridSize }, (_, c) => r * gridSize + c));
  for (let c = 0; c < gridSize; c++) lines.push(Array.from({ length: gridSize }, (_, r) => r * gridSize + c));
  lines.push(Array.from({ length: gridSize }, (_, i) => i * gridSize + i));
  lines.push(Array.from({ length: gridSize }, (_, i) => i * gridSize + (gridSize - 1 - i)));
  return lines;
}

/** Evalúa una tarjeta dado un array de marcas por celda (las casillas libres cuentan como marcadas). */
export function evaluateMarks(card: Card, marks: readonly boolean[]): CardEvaluation {
  const marked = card.cells.map((cell, i) => cell === null || marks[i] === true);
  const completedLines = winningLines(card.gridSize).filter((line) => line.every((i) => marked[i]));
  const remaining = marked.filter((m) => !m).length;
  const status: CardStatus = remaining === 0 ? 'full' : completedLines.length > 0 ? 'line' : 'none';
  return { marked, completedLines, status, remaining };
}

/** Evalúa una tarjeta contra el conjunto de canciones ya cantadas (índices del pool). */
export function evaluateCard(card: Card, called: ReadonlySet<number>): CardEvaluation {
  const marks = card.cells.map((cell) => cell !== null && called.has(cell));
  return evaluateMarks(card, marks);
}

/** Código legible de una tarjeta: CÓDIGO-PARTIDA · nº. */
export function cardLabel(seed: string, index: number): string {
  return `${seed}-${index + 1}`;
}
