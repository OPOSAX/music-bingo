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
}

export function renderCardGrid(options: CardGridOptions): HTMLElement {
  const { gridSize, cells, marked, highlighted, onToggle, compact } = options;
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
  return grid;
}
