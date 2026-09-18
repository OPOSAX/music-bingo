/** Todas las tarjetas de la partida: para imprimir o compartir por enlace. */

import type { Track } from '../bingo.js';
import { cardLabel } from '../bingo.js';
import { button, clear, copyText, errorMessage, h, toast } from '../dom.js';
import { navigate } from '../router.js';
import type { SharedCard } from '../share.js';
import { encodeSharedCard } from '../share.js';
import type { GameState } from '../store.js';
import { gameCards, loadGame } from '../store.js';
import { renderCardGrid } from './card-grid.js';

export function cardShareUrl(game: GameState, index: number): Promise<string> {
  const card = gameCards(game)[index];
  if (!card) throw new Error('Tarjeta inexistente.');
  const shared: SharedCard = {
    v: 1,
    g: game.config.seed,
    n: index,
    s: game.config.gridSize,
    t: game.playlistName,
    c: card.cells.map((c) => (c === null ? null : [(game.tracks[c] as Track).name, (game.tracks[c] as Track).artists])),
  };
  return encodeSharedCard(shared).then((payload) => `${location.origin}${location.pathname}#/card?d=${payload}`);
}

export async function renderCards(root: HTMLElement): Promise<void> {
  clear(root);
  const loaded = loadGame();
  if (!loaded) {
    root.appendChild(h('section', { class: 'panel' }, h('h2', null, 'No hay ninguna partida'), button('Crear partida', () => navigate('/setup'), 'btn btn-primary')));
    return;
  }
  const game: GameState = loaded;
  const cards = gameCards(game);

  root.appendChild(
    h(
      'header',
      { class: 'page-header no-print' },
      h('div', null, h('h1', null, `Tarjetas · partida ${game.config.seed}`), h('p', { class: 'muted' }, `${cards.length} tarjetas · ${game.playlistName}`)),
      h('div', { class: 'actions' }, button('🖨 Imprimir', () => window.print(), 'btn'), button('Copiar todos los enlaces', () => void copyAll(), 'btn'), button('← Partida', () => navigate('/host'), 'btn btn-link')),
    ),
  );
  root.appendChild(
    h('p', { class: 'muted no-print' }, 'Cada jugador necesita una tarjeta: imprímelas, o envía a cada persona el enlace de su tarjeta (se abre en el móvil sin cuenta de Spotify). El anfitrión puede comprobar cualquier tarjeta por su número.'),
  );

  const list = h('div', { class: 'cards-list' });
  root.appendChild(list);

  for (const card of cards) {
    const label = cardLabel(game.config.seed, card.index);
    const actions = h('div', { class: 'actions no-print' });
    actions.appendChild(
      button('Copiar enlace', async () => {
        try {
          const ok = await copyText(await cardShareUrl(game, card.index));
          toast(ok ? `Enlace de la tarjeta ${card.index + 1} copiado` : 'No se pudo copiar', ok ? 'success' : 'error');
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      }, 'btn btn-sm'),
    );
    if (typeof navigator.share === 'function') {
      actions.appendChild(
        button('Compartir…', async () => {
          try {
            const url = await cardShareUrl(game, card.index);
            await navigator.share({ title: `Bingo musical · tarjeta ${label}`, text: `Tu tarjeta ${label} del bingo musical`, url });
          } catch (err) {
            if ((err as Error).name !== 'AbortError') toast(errorMessage(err), 'error');
          }
        }, 'btn btn-sm'),
      );
    }
    actions.appendChild(button('Abrir', () => void cardShareUrl(game, card.index).then((url) => window.open(url, '_blank')), 'btn btn-sm'));

    list.appendChild(
      h(
        'article',
        { class: 'card-sheet' },
        h('header', { class: 'card-sheet-header' }, h('h3', null, `Tarjeta ${card.index + 1}`), h('span', { class: 'muted' }, `Código ${label} · ${game.playlistName}`)),
        renderCardGrid({
          gridSize: card.gridSize,
          cells: card.cells.map((c) => (c === null ? null : { title: (game.tracks[c] as Track).name, subtitle: (game.tracks[c] as Track).artists })),
          marked: card.cells.map(() => false),
          compact: true,
        }),
        actions,
      ),
    );
  }

  async function copyAll(): Promise<void> {
    try {
      const lines = await Promise.all(cards.map(async (c) => `Tarjeta ${c.index + 1}: ${await cardShareUrl(game, c.index)}`));
      const ok = await copyText(lines.join('\n'));
      toast(ok ? 'Enlaces copiados al portapapeles' : 'No se pudo copiar', ok ? 'success' : 'error');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }
}
