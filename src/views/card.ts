/** Vista del jugador: su tarjeta, para marcar las canciones que va reconociendo. */

import type { Card } from '../bingo.js';
import { cardLabel, evaluateMarks } from '../bingo.js';
import { button, clear, errorMessage, h, toast } from '../dom.js';
import { navigate } from '../router.js';
import { decodeSharedCard, type SharedCard } from '../share.js';
import { loadMarks, saveMarks } from '../store.js';
import { renderCardGrid } from './card-grid.js';

export async function renderPlayerCard(root: HTMLElement, params: URLSearchParams): Promise<void> {
  clear(root);
  const payload = params.get('d');
  if (!payload) {
    root.appendChild(h('section', { class: 'panel' }, h('p', { class: 'alert alert-error' }, 'Falta la tarjeta en el enlace.'), button('Inicio', () => navigate('/'), 'btn')));
    return;
  }
  let shared: SharedCard;
  try {
    shared = await decodeSharedCard(payload);
  } catch (err) {
    root.appendChild(h('section', { class: 'panel' }, h('p', { class: 'alert alert-error' }, errorMessage(err)), button('Inicio', () => navigate('/'), 'btn')));
    return;
  }

  const card: Card = { index: shared.n, gridSize: shared.s, cells: shared.c.map((c, i) => (c === null ? null : i)) };
  const cells = shared.c.map((c) => (c === null ? null : { title: c[0], subtitle: c[1] }));
  let marks = loadMarks(shared.g, shared.n, cells.length);
  const label = cardLabel(shared.g, shared.n);

  const banner = h('div', { class: 'banner' });
  const gridHost = h('div', { class: 'player-grid' });
  root.appendChild(
    h(
      'header',
      { class: 'page-header' },
      h('div', null, h('h1', null, `Tarjeta ${shared.n + 1}`), h('p', { class: 'muted' }, `Código ${label} · ${shared.t}`)),
    ),
  );
  root.appendChild(banner);
  root.appendChild(gridHost);
  root.appendChild(h('p', { class: 'muted small center' }, 'Toca una casilla cuando suene esa canción. Cuando completes una línea o la tarjeta, canta ¡BINGO! y di tu código al anfitrión.'));
  root.appendChild(
    h('div', { class: 'actions center' }, button('Borrar marcas', () => {
      if (!confirm('¿Borrar todas las marcas de esta tarjeta?')) return;
      marks = marks.map(() => false);
      saveMarks(shared.g, shared.n, marks);
      render();
    }, 'btn btn-sm')),
  );

  let lastStatus = evaluateMarks(card, marks).status;

  function render(): void {
    const ev = evaluateMarks(card, marks);
    clear(gridHost);
    gridHost.appendChild(
      renderCardGrid({
        gridSize: card.gridSize,
        cells,
        marked: ev.marked,
        highlighted: new Set(ev.completedLines.flat()),
        onToggle: (i) => {
          marks[i] = !marks[i];
          saveMarks(shared.g, shared.n, marks);
          render();
        },
      }),
    );
    clear(banner);
    banner.className = `banner banner-${ev.status}`;
    if (ev.status === 'full') banner.textContent = `🎉 ¡BINGO! Tarjeta completa · código ${label}`;
    else if (ev.status === 'line') banner.textContent = `➖ ¡LÍNEA! (${ev.completedLines.length}) · código ${label}`;
    else banner.textContent = `Te faltan ${ev.remaining} canciones`;
    if (ev.status !== lastStatus && ev.status !== 'none') {
      toast(ev.status === 'full' ? '¡BINGO! 🎉' : '¡Línea!', 'success');
      navigator.vibrate?.(ev.status === 'full' ? [100, 50, 100, 50, 300] : [80, 40, 80]);
    }
    lastStatus = ev.status;
  }
  render();
}
