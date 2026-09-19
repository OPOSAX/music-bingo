/** Vista del jugador: su tarjeta, para marcar las canciones que va reconociendo. */

import type { Card } from '../bingo.js';
import { cardLabel, evaluateMarks } from '../bingo.js';
import { button, clear, errorMessage, h, toast } from '../dom.js';
import { navigate } from '../router.js';
import { decodeSharedCard, type SharedCard } from '../share.js';
import { loadMarks, saveMarks } from '../store.js';
import { autoMarkedCells, subscribeState, type SyncState } from '../sync.js';
import { renderCardGrid } from './card-grid.js';
import { createLyricsPanel, lyricsToggle, type LyricsPanel } from './lyrics-panel.js';

let subscription: { close(): void } | null = null;
let lyricsPanel: LyricsPanel | null = null;

/** Cierra la conexión con el anfitrión al salir de la tarjeta. */
export function releaseCardSync(): void {
  subscription?.close();
  subscription = null;
  lyricsPanel?.destroy();
  lyricsPanel = null;
}

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
  const poolIndices: (number | null)[] = shared.i ?? cells.map(() => null);
  let marks = loadMarks(shared.g, shared.n, cells.length);
  const label = cardLabel(shared.g, shared.n);
  let syncState: SyncState | null = null;
  let autoMarks: boolean[] = cells.map(() => false);

  const banner = h('div', { class: 'banner' });
  const live = h('div', { class: 'live' });
  const feed = h('div', { class: 'feed' });
  const gridHost = h('div', { class: 'player-grid' });
  releaseCardSync();
  lyricsPanel = createLyricsPanel({ compact: true });
  lyricsPanel.el.hidden = true;
  const lyricsBtn = lyricsToggle(lyricsPanel);
  lyricsBtn.hidden = true;
  root.appendChild(
    h(
      'header',
      { class: 'page-header' },
      h('div', null, h('h1', null, `Tarjeta ${shared.n + 1}`), h('p', { class: 'muted' }, `Código ${label} · ${shared.t}`)),
    ),
  );
  root.appendChild(banner);
  root.appendChild(live);
  root.appendChild(lyricsPanel.el);
  root.appendChild(gridHost);
  root.appendChild(feed);
  root.appendChild(h('p', { class: 'muted small center' }, shared.y ? 'Las canciones que van sonando se marcan solas; también puedes tocar una casilla. Cuando completes una línea o la tarjeta, canta ¡BINGO! y di tu código al anfitrión.' : 'Toca una casilla cuando suene esa canción. Cuando completes una línea o la tarjeta, canta ¡BINGO! y di tu código al anfitrión.'));
  root.appendChild(
    h('div', { class: 'actions center' }, button('Borrar marcas', () => {
      if (!confirm('¿Borrar todas las marcas de esta tarjeta?')) return;
      marks = marks.map(() => false);
      saveMarks(shared.g, shared.n, marks);
      render();
    }, 'btn btn-sm')),
  );

  let lastStatus = evaluateMarks(card, marks).status;

  function renderLive(online: boolean | null): void {
    clear(live);
    if (!shared.y) return;
    if (!syncState) {
      live.appendChild(h('p', { class: 'muted small' }, online === false ? '⚠️ Sin conexión con el anfitrión. Reintentando…' : '⏳ Conectando con el anfitrión…'));
      return;
    }
    const n = syncState.called.length;
    const nowText = syncState.now ? `${syncState.now.name} — ${syncState.now.artists}` : n > 0 ? `Canción nº ${n} (título sin revelar)` : 'Todavía no ha sonado ninguna canción';
    live.appendChild(h('p', { class: 'live-now' }, h('span', { class: 'muted small' }, `${online === false ? '⚠️ Sin conexión · ' : '🔊 En directo · '}${n} cantadas`), h('br'), nowText));
    if (syncState.msg?.text) live.appendChild(h('p', { class: 'live-msg' }, '💬 ', syncState.msg.text));
    if (lyricsPanel) {
      if (syncState.cur) {
        lyricsBtn.hidden = false;
        live.appendChild(h('div', { class: 'actions center' }, lyricsBtn));
        if (!lyricsBtn.dataset.userHidden) lyricsPanel.el.hidden = false;
        lyricsPanel.show(syncState.cur, syncState.play ?? null);
      } else {
        lyricsPanel.el.hidden = true;
        lyricsPanel.show(null, null);
      }
    }

    clear(feed);
    const log = syncState.log ?? [];
    if (log.length) {
      feed.appendChild(h('h3', null, 'Canciones cantadas'));
      const list = h('ol', { class: 'feed-list' });
      for (const [num, name, artists] of [...log].reverse()) list.appendChild(h('li', null, h('span', { class: 'feed-n' }, `${num}.`), h('strong', null, name), h('span', { class: 'muted' }, ` — ${artists}`)));
      feed.appendChild(list);
    }
  }

  function render(): void {
    const combined = marks.map((m, i) => m || autoMarks[i] === true);
    const ev = evaluateMarks(card, combined);
    clear(gridHost);
    gridHost.appendChild(
      renderCardGrid({
        gridSize: card.gridSize,
        cells,
        marked: ev.marked,
        highlighted: new Set(ev.completedLines.flat()),
        onToggle: (i) => {
          if (autoMarks[i]) return; // lo marcó el anfitrión: no se puede desmarcar
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
  renderLive(null);

  lyricsBtn.addEventListener('click', () => {
    if (lyricsPanel?.el.hidden) lyricsBtn.dataset.userHidden = '1';
    else delete lyricsBtn.dataset.userHidden;
  });

  if (shared.y) {
    subscription = subscribeState(
      shared.y,
      (state) => {
        if (state.seed !== shared.g) return;
        syncState = state;
        autoMarks = autoMarkedCells(poolIndices, state);
        render();
        renderLive(true);
      },
      (online) => renderLive(online),
    );
  }
}
