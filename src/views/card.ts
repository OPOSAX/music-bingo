/** Vista del jugador: una o varias tarjetas en la misma sesión, con vídeo del animador cuando el evento es Live. */

import type { Card } from '../bingo.js';
import { cardLabel, evaluateMarks } from '../bingo.js';
import { button, clear, errorMessage, h, toast } from '../dom.js';
import { navigate } from '../router.js';
import { decodeSharedCard, type SharedCard } from '../share.js';
import { loadMarks, playerId, saveMarks } from '../store.js';
import { autoMarkedCells, subscribeState, type LiveLink, type SyncState } from '../sync.js';
import { LIVE_EVENTS } from '../live/protocol.js';
import { liveSession, releaseLiveSessions, type LiveSession } from '../live/session.js';
import { createLiveHostVideo, type LiveHostVideo } from '../live/views/live-video.js';
import { liveRoomId } from '../live/protocol.js';
import { createKaraokePanel } from '../concert/views/sing.js';
import { renderCardGrid } from './card-grid.js';
import { createLyricsPanel, lyricsToggle, type LyricsPanel } from './lyrics-panel.js';

let subscription: { close(): void } | null = null;
let lyricsPanel: LyricsPanel | null = null;
let liveVideo: LiveHostVideo | null = null;

/** Cierra la conexión con el anfitrión al salir de la tarjeta. */
export function releaseCardSync(): void {
  subscription?.close();
  subscription = null;
  lyricsPanel?.destroy();
  lyricsPanel = null;
  liveVideo?.destroy();
  liveVideo = null;
  releaseLiveSessions();
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
  renderCardView(root, shared);
}

/** Pinta la tarjeta de un jugador (desde un enlace de tarjeta o desde el QR único). */
export function renderCardView(root: HTMLElement, shared: SharedCard, playerName = ''): void {
  const opts: PlayerCardsOptions = {};
  if (shared.l) {
    opts.liveUrl = shared.l;
    opts.liveEvent = shared.g;
    opts.karaoke = { url: shared.l, room: liveRoomId(shared.g) };
  }
  renderPlayerCards(root, [shared], playerName, opts);
}

export interface PlayerCardsOptions {
  /** Servidor Live (vídeo del animador + plano de juego por socket). */
  liveUrl?: string | undefined;
  /** Identificador del evento (sala `bingo-<evento>`); por defecto el código de partida. */
  liveEvent?: string | undefined;
  /** Karaoke del evento: servidor y sala donde el jugador puede apuntarse para cantar. */
  karaoke?: { url: string; room: string } | undefined;
}

interface CardState {
  shared: SharedCard;
  card: Card;
  cells: ({ title: string; subtitle: string } | null)[];
  poolIndices: (number | null)[];
  marks: boolean[];
  autoMarks: boolean[];
  lastStatus: 'none' | 'line' | 'full';
  el: HTMLElement;
  grid: HTMLElement;
  banner: HTMLElement;
  bingoBtn: HTMLButtonElement;
  lastClaimAt: number;
}

/** Varias tarjetas en una sola pantalla: pestañas, marcas independientes y un único vídeo/estado compartido. */
export function renderPlayerCards(root: HTMLElement, cards: SharedCard[], playerName = '', options: PlayerCardsOptions = {}): void {
  clear(root);
  releaseCardSync();
  const first = cards[0];
  if (!first) {
    root.appendChild(h('section', { class: 'panel' }, h('p', { class: 'alert alert-error' }, 'No tienes tarjetas para este evento.')));
    return;
  }
  const liveLink: LiveLink | undefined = options.liveUrl ? { url: options.liveUrl, event: options.liveEvent ?? first.g } : undefined;
  const session: LiveSession | null = liveLink ? liveSession(liveLink, { name: playerName || (localStorage.getItem('musicbingo:playerName') ?? '') }) : null;
  const topic = first.y;
  let syncState: SyncState | null = null;

  const live = h('div', { class: 'live' });
  const feed = h('div', { class: 'feed' });
  lyricsPanel = createLyricsPanel({ compact: true });
  lyricsPanel.el.hidden = true;
  const lyricsBtn = lyricsToggle(lyricsPanel);
  lyricsBtn.hidden = true;

  // Karaoke: el mismo control vive junto al botón de la letra y sobrevive a los repintados del área "en directo".
  const karaokeEl = options.karaoke ? createKaraokePanel({ btalkUrl: options.karaoke.url, roomId: options.karaoke.room }, { name: playerName, compact: true }) : null;
  const tools = () => h('div', { class: 'actions center live-tools' }, lyricsBtn, karaokeEl);
  const states: CardState[] = cards.map((shared) => buildCard(shared));
  let selected = 0;
  const tabs = h('div', { class: 'card-tabs' });
  const tabsTitle = h('span', { class: 'muted small' });
  const drawTabs = () => {
    clear(tabs);
    if (states.length < 2) return;
    tabs.appendChild(button('←', () => select(selected - 1), 'btn btn-sm'));
    states.forEach((s, i) => {
      const ev = evaluateMarks(s.card, s.marks.map((m, k) => m || s.autoMarks[k] === true));
      tabs.appendChild(button(`${i + 1}${ev.status === 'full' ? ' 🎉' : ev.status === 'line' ? ' ➖' : ''}`, () => select(i), `btn btn-sm ${i === selected ? 'btn-primary' : ''}`));
    });
    tabs.appendChild(button('→', () => select(selected + 1), 'btn btn-sm'));
    tabsTitle.textContent = `Tarjeta ${selected + 1} de ${states.length}`;
  };
  const select = (i: number) => {
    selected = (i + states.length) % states.length;
    states.forEach((s, k) => (s.el.hidden = k !== selected));
    drawTabs();
  };

  root.appendChild(
    h(
      'header',
      { class: 'page-header' },
      h('div', null, h('h1', null, playerName ? `${playerName} · ${states.length > 1 ? `${states.length} tarjetas` : `Tarjeta ${first.n + 1}`}` : `Tarjeta ${first.n + 1}`), h('p', { class: 'muted' }, `${states.length > 1 ? '' : `Código ${cardLabel(first.g, first.n)} · `}${first.t}`)),
    ),
  );
  if (session) {
    liveVideo = createLiveHostVideo(session);
    root.appendChild(liveVideo.el);
  }
  root.appendChild(live);
  root.appendChild(lyricsPanel.el);
  if (states.length > 1) root.appendChild(h('div', { class: 'card-tabs-wrap' }, tabsTitle, tabs));
  for (const s of states) root.appendChild(s.el);
  root.appendChild(feed);
  root.appendChild(h('p', { class: 'muted small center' }, topic ? 'Las canciones que van sonando se marcan solas; también puedes tocar una casilla. Cuando completes una línea o la tarjeta, canta ¡BINGO!' : 'Toca una casilla cuando suene esa canción. Cuando completes una línea o la tarjeta, canta ¡BINGO! y di tu código al anfitrión.'));
  root.appendChild(
    h('div', { class: 'actions center' }, button('Borrar marcas', () => {
      if (!confirm('¿Borrar todas las marcas de esta tarjeta?')) return;
      const s = states[selected] as CardState;
      s.marks = s.marks.map(() => false);
      saveMarks(s.shared.g, s.shared.n, s.marks);
      render(s);
    }, 'btn btn-sm')),
  );
  select(0);

  function buildCard(shared: SharedCard): CardState {
    const card: Card = { index: shared.n, gridSize: shared.s, cells: shared.c.map((c, i) => (c === null ? null : i)) };
    const cells = shared.c.map((c) => (c === null ? null : { title: c[0], subtitle: c[1] }));
    const poolIndices: (number | null)[] = shared.i ?? cells.map(() => null);
    const marks = loadMarks(shared.g, shared.n, cells.length);
    const banner = h('div', { class: 'banner' });
    const grid = h('div', { class: 'player-grid' });
    const bingoBtn = button('🎉 ¡BINGO!', () => void claimBingo(state), 'btn btn-primary btn-xl bingo-btn');
    bingoBtn.hidden = true;
    const el = h('div', { class: 'player-card' }, cards.length > 1 ? h('p', { class: 'small muted center' }, `Código ${cardLabel(shared.g, shared.n)}`) : null, banner, bingoBtn, grid);
    const state: CardState = { shared, card, cells, poolIndices, marks, autoMarks: cells.map(() => false), lastStatus: evaluateMarks(card, marks).status, el, grid, banner, bingoBtn, lastClaimAt: 0 };
    render(state);
    return state;
  }

  async function claimBingo(s: CardState): Promise<void> {
    if (!session) return;
    const ev = evaluateMarks(s.card, s.marks.map((m, i) => m || s.autoMarks[i] === true));
    if (ev.status === 'none' || Date.now() - s.lastClaimAt < 3000) return;
    s.lastClaimAt = Date.now();
    s.bingoBtn.disabled = true;
    try {
      const r = await session.request<{ valid: boolean | null }>(LIVE_EVENTS.bingo, { seed: s.shared.g, index: s.shared.n, name: playerName, cid: playerId(), kind: ev.status });
      toast(r.valid === false ? 'El servidor no ve tu tarjeta completa todavía; el animador lo comprobará.' : '¡Bingo enviado al animador!', r.valid === false ? 'info' : 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setTimeout(() => (s.bingoBtn.disabled = false), 3000);
    }
  }

  function render(s: CardState): void {
    const combined = s.marks.map((m, i) => m || s.autoMarks[i] === true);
    const ev = evaluateMarks(s.card, combined);
    clear(s.grid);
    s.grid.appendChild(
      renderCardGrid({
        gridSize: s.card.gridSize,
        cells: s.cells,
        marked: ev.marked,
        highlighted: new Set(ev.completedLines.flat()),
        onToggle: (i) => {
          if (s.autoMarks[i]) return; // lo marcó el anfitrión: no se puede desmarcar
          s.marks[i] = !s.marks[i];
          saveMarks(s.shared.g, s.shared.n, s.marks);
          render(s);
          drawTabs();
        },
      }),
    );
    clear(s.banner);
    const label = cardLabel(s.shared.g, s.shared.n);
    s.banner.className = `banner banner-${ev.status}`;
    if (ev.status === 'full') s.banner.textContent = `🎉 ¡BINGO! Tarjeta completa · código ${label}`;
    else if (ev.status === 'line') s.banner.textContent = `➖ ¡LÍNEA! (${ev.completedLines.length}) · código ${label}`;
    else s.banner.textContent = `Te faltan ${ev.remaining} canciones`;
    if (session) {
      s.bingoBtn.hidden = ev.status === 'none';
      s.bingoBtn.textContent = ev.status === 'full' ? '🎉 ¡BINGO!' : '➖ ¡Cantar línea!';
    }
    if (ev.status !== s.lastStatus && ev.status !== 'none') {
      toast(ev.status === 'full' ? `¡BINGO! 🎉 (tarjeta ${s.shared.n + 1})` : `¡Línea! (tarjeta ${s.shared.n + 1})`, 'success');
      navigator.vibrate?.(ev.status === 'full' ? [100, 50, 100, 50, 300] : [80, 40, 80]);
    }
    s.lastStatus = ev.status;
  }

  function renderLive(online: boolean | null): void {
    clear(live);
    if (!topic && !liveLink) return;
    if (!syncState) {
      live.appendChild(h('p', { class: 'muted small' }, online === false ? '⚠️ Sin conexión con el anfitrión. Reintentando…' : '⏳ Conectando con el anfitrión…'));
      if (karaokeEl) live.appendChild(tools());
      return;
    }
    const n = syncState.called.length;
    const nowText = syncState.now ? `${syncState.now.name} — ${syncState.now.artists}` : n > 0 ? `Canción nº ${n} (título sin revelar)` : 'Todavía no ha sonado ninguna canción';
    live.appendChild(h('p', { class: 'live-now' }, h('span', { class: 'muted small' }, `${online === false ? '⚠️ Sin conexión · ' : '🎵 Ahora sonando · '}${n} cantadas`), h('br'), nowText));
    if (syncState.msg?.text) live.appendChild(h('p', { class: 'live-msg' }, '💬 ', syncState.msg.text));
    if (lyricsPanel) {
      if (syncState.cur) {
        lyricsBtn.hidden = false;
        if (!lyricsBtn.dataset.userHidden) lyricsPanel.el.hidden = false;
        lyricsPanel.show(syncState.cur, syncState.play ?? null);
      } else {
        lyricsBtn.hidden = true;
        lyricsPanel.el.hidden = true;
        lyricsPanel.show(null, null);
      }
    }
    if (syncState.cur || karaokeEl) live.appendChild(tools());
    clear(feed);
    const log = syncState.log ?? [];
    if (log.length) {
      feed.appendChild(h('h3', null, 'Canciones cantadas'));
      const list = h('ol', { class: 'feed-list' });
      for (const [num, name, artists] of [...log].reverse()) list.appendChild(h('li', null, h('span', { class: 'feed-n' }, `${num}.`), h('strong', null, name), h('span', { class: 'muted' }, ` — ${artists}`)));
      feed.appendChild(list);
    }
  }
  renderLive(null);

  lyricsBtn.addEventListener('click', () => {
    if (lyricsPanel?.el.hidden) lyricsBtn.dataset.userHidden = '1';
    else delete lyricsBtn.dataset.userHidden;
  });

  if (topic || liveLink) {
    subscription = subscribeState(
      topic ?? '',
      (state) => {
        if (state.seed !== first.g) return;
        syncState = state;
        for (const s of states) {
          s.autoMarks = autoMarkedCells(s.poolIndices, state);
          render(s);
        }
        drawTabs();
        renderLive(true);
      },
      (online) => renderLive(online),
      liveLink,
    );
  }
}
