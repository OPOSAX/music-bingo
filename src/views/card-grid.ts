/** Renderizado de una tarjeta de bingo (compartido entre anfitrión y jugador). */

import type { GridSize } from '../bingo.js';
import { h } from '../dom.js';

export interface GridCell {
  title: string;
  subtitle: string;
}

export interface CardGridOptions {
  gridSize: GridSize;
  cells: (GridCell | null)[];
  marked: readonly boolean[];
  /** Índices de celda que forman parte de una línea completa. */
  highlighted?: ReadonlySet<number>;
  onToggle?: (index: number) => void;
  compact?: boolean;
  /** Aspecto de cartón de bingo: cabecera con letras, casillas en cuadrícula y sello al marcar. */
  bingo?: boolean;
  /** Texto de la cabecera del cartón (p. ej. número de tarjeta). */
  label?: string;
}

/** Letras de la cabecera según el tamaño: B·I·N·G·O para 5×5; H·I·T·S y H·I·T para los pequeños. */
export function headerLetters(gridSize: GridSize): string[] {
  return gridSize === 5 ? ['B', 'I', 'N', 'G', 'O'] : gridSize === 4 ? ['H', 'I', 'T', 'S'] : ['H', 'I', 'T'];
}

export function renderCardGrid(options: CardGridOptions): HTMLElement {
  const { gridSize, cells, marked, highlighted, onToggle, compact, bingo, label } = options;
  const grid = h('div', {
    class: `card-grid size-${gridSize}${compact ? ' compact' : ''}${onToggle ? ' interactive' : ''}`,
    style: { gridTemplateColumns: `repeat(${gridSize}, 1fr)` },
  });
  cells.forEach((cell, i) => {
    const classes = ['cell'];
    if (cell === null) classes.push('free');
    if (marked[i]) classes.push('marked');
    if (highlighted?.has(i)) classes.push('in-line');
    const el = h(
      onToggle && cell !== null ? 'button' : 'div',
      { class: classes.join(' '), attrs: { 'aria-pressed': marked[i] ? 'true' : 'false' } },
      cell === null
        ? h('span', { class: 'cell-free' }, '★ LIBRE')
        : [h('span', { class: 'cell-title' }, cell.title), h('span', { class: 'cell-sub' }, cell.subtitle)],
    );
    if (onToggle && cell !== null) {
      (el as HTMLButtonElement).type = 'button';
      el.addEventListener('click', () => onToggle(i));
    }
    grid.appendChild(el);
  });
  if (!bingo) return grid;
  const letters = h('div', { class: 'bingo-letters', style: { gridTemplateColumns: `repeat(${gridSize}, 1fr)` } }, ...headerLetters(gridSize).map((l) => h('span', null, l)));
  return h('div', { class: `bingo-card size-${gridSize}` }, h('div', { class: 'bingo-head' }, h('span', { class: 'bingo-brand' }, '🎵 BINGO HIT'), label ? h('span', { class: 'bingo-label' }, label) : null), letters, grid);
}
