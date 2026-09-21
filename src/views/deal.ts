/** Reparto de tarjetas: muestra el QR de cada tarjeta en grande, de una en una, para que cada jugador escanee el suyo. */

import { cardLabel } from '../bingo.js';
import { button, clear, copyText, errorMessage, h, toast } from '../dom.js';
import { encodeText, toSvgElement } from '../qr.js';
import { navigate } from '../router.js';
import type { GameState } from '../store.js';
import { cardName, loadGame, setCardName } from '../store.js';
import { encodeJoinPayload } from '../share.js';
import { cardShareUrl } from './cards.js';

/** Enlace del QR único de la partida. */
export async function joinUrl(game: GameState): Promise<string> {
  const base = `${location.origin}${location.pathname.replace(/index\.html$/, '')}`;
  // Con Bingo Hit Live el enlace es corto: la partida se obtiene del servidor (/play?e=evento).
  if (game.liveServer) return `${base}#/play?e=${encodeURIComponent(game.eventId ?? game.config.seed)}&l=${encodeURIComponent(game.liveServer)}`;
  const payload = await encodeJoinPayload({
    v: 1,
    g: game.config.seed,
    s: game.config.gridSize,
    f: game.config.freeCenter,
    n: game.config.cardCount,
    p: game.tracks.length,
    y: game.syncTopic ?? '',
    t: game.playlistName,
  });
  return `${base}#/join?d=${payload}`;
}

export async function renderDeal(root: HTMLElement, params: URLSearchParams): Promise<void> {
  clear(root);
  const loaded = loadGame();
  if (!loaded) {
    root.appendChild(h('section', { class: 'panel' }, h('h2', null, 'No hay ninguna partida'), button('Crear partida', () => navigate('/setup'), 'btn btn-primary')));
    return;
  }
  const game: GameState = loaded;
  const total = game.config.cardCount;
  let index = Math.min(total - 1, Math.max(0, Number(params.get('n') ?? '1') - 1 || 0));
  const mode = params.get('m') === 'cards' ? 'cards' : 'join';

  if (mode === 'join' && game.syncTopic) {
    renderJoinMode(root, game);
    return;
  }

  const title = h('h1', null);
  const subtitle = h('p', { class: 'muted' });
  const qrHost = h('div', { class: 'deal-qr' });
  const prevBtn = button('← Anterior', () => show(index - 1), 'btn btn-lg');
  const nextBtn = button('Siguiente tarjeta →', () => show(index + 1), 'btn btn-primary btn-lg');
  const copyBtn = button('Copiar enlace', () => void copyCurrent(), 'btn');
  const nameInput = h('input', { class: 'input', type: 'text', placeholder: 'Nombre del jugador (opcional)', autocomplete: 'off' });
  nameInput.addEventListener('change', () => setCardName(game, index, nameInput.value));
  const jump = h('input', { class: 'input', type: 'number', min: '1', max: String(total), value: String(index + 1) });
  jump.addEventListener('change', () => show(Number(jump.value) - 1));

  root.appendChild(
    h(
      'header',
      { class: 'page-header' },
      h('div', null, title, subtitle),
      h('div', { class: 'actions' }, button('QR único', () => navigate('/deal'), 'btn'), button('Tarjetas', () => navigate('/cards'), 'btn'), button('← Partida', () => navigate('/host'), 'btn btn-link')),
    ),
  );
  root.appendChild(
    h(
      'section',
      { class: 'panel deal-panel' },
      qrHost,
      h('p', { class: 'deal-hint' }, 'Escanea el QR con la cámara del móvil para abrir tu tarjeta. Cuando la tengas, el anfitrión pasa a la siguiente.'),
      h('div', { class: 'actions center' }, prevBtn, h('label', { class: 'field deal-jump' }, h('span', null, 'Ir a la tarjeta'), jump), nextBtn),
      h('div', { class: 'actions center' }, h('label', { class: 'field deal-name' }, h('span', null, 'Jugador de esta tarjeta'), nameInput), copyBtn),
    ),
  );

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'ArrowRight' || ev.key === ' ') show(index + 1);
    else if (ev.key === 'ArrowLeft') show(index - 1);
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', () => window.removeEventListener('keydown', onKey), { once: true });

  async function copyCurrent(): Promise<void> {
    try {
      const ok = await copyText(await cardShareUrl(game, index));
      toast(ok ? 'Enlace copiado' : 'No se pudo copiar', ok ? 'success' : 'error');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  function show(i: number): void {
    if (i < 0 || i >= total) return;
    index = i;
    jump.value = String(i + 1);
    nameInput.value = cardName(game, i);
    history.replaceState(null, '', `#/deal?n=${i + 1}`);
    title.textContent = `Tarjeta ${i + 1} de ${total}`;
    subtitle.textContent = `Código ${cardLabel(game.config.seed, i)} · ${game.playlistName}`;
    prevBtn.disabled = i === 0;
    nextBtn.disabled = i === total - 1;
    clear(qrHost);
    qrHost.appendChild(h('p', { class: 'muted' }, 'Generando QR…'));
    void cardShareUrl(game, i)
      .then((url) => {
        if (index !== i) return;
        clear(qrHost);
        qrHost.appendChild(toSvgElement(encodeText(url, { ecc: 'M' }), { border: 3 }));
      })
      .catch((err) => {
        clear(qrHost);
        qrHost.appendChild(h('p', { class: 'alert alert-error' }, errorMessage(err)));
      });
  }

  show(index);
}

/** QR único: todos escanean el mismo código, escriben su nombre y reciben la siguiente tarjeta libre. */
function renderJoinMode(root: HTMLElement, game: GameState): void {
  const qrHost = h('div', { class: 'deal-qr' }, h('p', { class: 'muted' }, 'Generando QR…'));
  const players = h('div', { class: 'players' });
  const linkEl = h('a', { class: 'deal-link muted small', href: '#', target: '_blank', rel: 'noopener' }, 'Enlace de la partida');
  let url = '';
  root.appendChild(
    h(
      'header',
      { class: 'page-header' },
      h('div', null, h('h1', null, 'Unirse a la partida'), h('p', { class: 'muted' }, `Partida ${game.config.seed} · ${game.playlistName} · ${game.config.cardCount} tarjetas`)),
      h('div', { class: 'actions' }, button('QR por tarjeta', () => navigate('/deal?m=cards'), 'btn'), button('Tarjetas', () => navigate('/cards'), 'btn'), button('← Partida', () => navigate('/host'), 'btn btn-link')),
    ),
  );
  root.appendChild(
    h(
      'section',
      { class: 'panel deal-panel' },
      qrHost,
      h('p', { class: 'deal-hint' }, 'Todos escanean este mismo QR, escriben su nombre y reciben una tarjeta. Mantén abierta la pantalla de la partida en tu dispositivo para que las peticiones se atiendan.'),
      h('div', { class: 'actions center' }, button('Copiar enlace', () => void copyText(url).then((ok) => toast(ok ? 'Enlace copiado' : 'No se pudo copiar', ok ? 'success' : 'error')), 'btn'), linkEl),
    ),
  );
  root.appendChild(h('section', { class: 'panel' }, h('h2', null, 'Jugadores'), players));

  void joinUrl(game)
    .then((joinLink) => {
      url = joinLink;
      linkEl.href = joinLink;
      clear(qrHost);
      qrHost.appendChild(toSvgElement(encodeText(joinLink, { ecc: 'M' }), { border: 3 }));
    })
    .catch((err) => {
      clear(qrHost);
      qrHost.appendChild(h('p', { class: 'alert alert-error' }, errorMessage(err)));
    });

  const renderPlayers = () => {
    const current = loadGame();
    const claims = current?.claims ?? {};
    clear(players);
    const entries = Object.entries(claims).sort((a, b) => Number(a[0]) - Number(b[0]));
    if (entries.length === 0) {
      players.appendChild(h('p', { class: 'muted' }, 'Todavía nadie se ha unido. Las peticiones las atiende la pantalla de la partida: ábrela en otra pestaña o vuelve a ella tras repartir.'));
      return;
    }
    const list = h('ul', { class: 'player-list' });
    for (const [i, v] of entries) list.appendChild(h('li', null, h('strong', null, v.n), h('span', { class: 'muted' }, ` · tarjeta ${Number(i) + 1}`)));
    players.appendChild(list);
  };
  renderPlayers();
  const timer = window.setInterval(renderPlayers, 2000);
  window.addEventListener('hashchange', () => window.clearInterval(timer), { once: true });
}
