/**
 * /play?e=<evento>&l=<servidor>: entrada del jugador. Con la plataforma, el servidor decide el acceso
 * (canPlayerJoinEvent) y devuelve sus tarjetas; sin evento registrado, se usa el flujo Live por cfg.
 */

import { button, clear, errorMessage, h } from '../../dom.js';
import { navigate } from '../../router.js';
import type { JoinPayload, SharedCard } from '../../share.js';
import { renderJoinPayload } from '../../views/join.js';
import { renderPlayerCards } from '../../views/card.js';
import { generateCard } from '../../bingo.js';
import { ApiError, playerApi, resolveServer, tokens, type AccessBundle } from '../../platform/api.js';
import { liveRoomId } from '../protocol.js';
import { subscribeViaSocket } from '../game-channel.js';
import type { GameConfigMessage } from '../protocol.js';

export async function renderPlay(root: HTMLElement, params: URLSearchParams): Promise<void> {
  clear(root);
  const event = (params.get('e') ?? '').trim();
  const url = await resolveServer(params.get('l'));
  if (!event || !url) {
    root.appendChild(h('section', { class: 'panel' }, h('p', { class: 'alert alert-error' }, 'Falta el evento o el servidor en el enlace.'), button('Inicio', () => navigate('/'), 'btn')));
    return;
  }
  // 1) Evento de la plataforma: acceso validado en el servidor.
  if (tokens.player()) {
    try {
      const access = await playerApi.access(event);
      if (!access.allowed) {
        if (access.reason === 'event-not-found') return legacyPlay(root, event, url);
        navigate(`/event?e=${encodeURIComponent(event)}`);
        return;
      }
      renderPlatformPlay(root, event, url, access);
      return;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate(`/event?e=${encodeURIComponent(event)}`);
        return;
      }
      if (err instanceof ApiError && err.status !== 404) {
        root.appendChild(h('section', { class: 'panel' }, h('p', { class: 'alert alert-error' }, errorMessage(err))));
        return;
      }
      // Sin respuesta del servidor (red caída): la partida clásica reintenta la conexión.
    }
  } else {
    try {
      await playerApi.event(event);
      navigate(`/event?e=${encodeURIComponent(event)}`);
      return;
    } catch (err) {
      if (err instanceof ApiError && err.status !== 404) {
        root.appendChild(h('section', { class: 'panel' }, h('p', { class: 'alert alert-error' }, errorMessage(err))));
        return;
      }
    }
  }
  await legacyPlay(root, event, url);
}

function renderPlatformPlay(root: HTMLElement, eventId: string, url: string, access: AccessBundle): void {
  const game = access.game!;
  const name = tokens.playerName();
  const cards: SharedCard[] = (access.cards ?? []).map((c) => {
    const card = generateCard({ seed: game.seed, gridSize: game.gridSize, freeCenter: game.freeCenter, cardCount: game.cardCount, snippetSeconds: 20, startMode: 'random' }, game.poolSize, c.index);
    const shared: SharedCard = { v: 1, g: game.seed, n: c.index, s: game.gridSize, t: game.title, c: card.cells.map((cell) => (cell === null ? null : (game.pool[cell] ?? ['?', '']))), i: card.cells, y: game.topic };
    if (access.live?.streaming) shared.l = url;
    return shared;
  });
  if (access.waiting && access.startsAt) {
    const panel = h('section', { class: 'panel center' }, h('h1', null, '✅ Tu tarjeta está lista'), h('p', { class: 'muted' }, `${cards.length} tarjeta(s) · ${access.event?.name ?? ''}`), h('p', { class: 'muted small' }, 'Bingo Hit comienza en'), h('div', { class: 'countdown-clock' }, '--:--:--'));
    const enter = button('ENTRAR', () => renderPlayerCards(root, cards, name, { liveEvent: eventId, liveUrl: access.live?.streaming ? url : undefined, karaoke: { url, room: liveRoomId(eventId) } }), 'btn btn-primary btn-xl');
    panel.appendChild(h('div', { class: 'actions center' }, enter, button('Ver el evento', () => navigate(`/event?e=${encodeURIComponent(eventId)}`), 'btn')));
    root.appendChild(panel);
    const clock = panel.querySelector('.countdown-clock') as HTMLElement;
    const tick = () => {
      const ms = Date.parse(access.startsAt as string) - Date.now();
      const s = Math.max(0, Math.floor(ms / 1000));
      clock.textContent = ms <= 0 ? '¡Ya empezó!' : `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    const timer = setInterval(() => (panel.isConnected ? tick() : clearInterval(timer)), 1000);
    return;
  }
  renderPlayerCards(root, cards, name, { liveEvent: eventId, liveUrl: access.live?.streaming ? url : undefined, karaoke: { url, room: liveRoomId(eventId) } });
}

/** Flujo previo a la plataforma: la partida (cfg) llega por el plano de juego del servidor Live. */
async function legacyPlay(root: HTMLElement, event: string, url: string): Promise<void> {
  clear(root);
  const status = h('p', { class: 'muted' }, 'Conectando con el evento…');
  root.appendChild(h('section', { class: 'panel center' }, h('h1', null, '🎵 Bingo Hit'), status));
  const link = { url, event };
  const sub = subscribeViaSocket(
    link,
    (msg) => {
      if (msg.k !== 'cfg') return;
      let cfg: GameConfigMessage;
      try {
        cfg = JSON.parse(msg.raw) as GameConfigMessage;
      } catch {
        return;
      }
      if (cfg.seed !== event) return;
      sub.close();
      const payload: JoinPayload = { v: 1, g: cfg.seed, s: cfg.gridSize, f: cfg.freeCenter, n: cfg.cardCount, p: cfg.poolSize, y: cfg.topic, t: cfg.title, l: url };
      void renderJoinPayload(root, payload);
    },
    (online) => {
      if (!online) status.textContent = 'Sin conexión con el servidor. Reintentando…';
    },
  );
  setTimeout(() => {
    if (status.isConnected) status.textContent = 'El anfitrión todavía no ha abierto la partida en este servidor. Espera un momento…';
  }, 8000);
}
