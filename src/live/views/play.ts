/** /play?e=<evento>&l=<servidor>: entrada corta al evento; la partida se obtiene del servidor Live. */

import { button, clear, h } from '../../dom.js';
import { navigate } from '../../router.js';
import { detectConcertServer } from '../../concert/session.js';
import type { JoinPayload } from '../../share.js';
import { renderJoinPayload } from '../../views/join.js';
import { subscribeViaSocket } from '../game-channel.js';
import type { GameConfigMessage } from '../protocol.js';

export async function renderPlay(root: HTMLElement, params: URLSearchParams): Promise<void> {
  clear(root);
  const event = (params.get('e') ?? '').trim();
  const url = (params.get('l') ?? (await detectConcertServer()) ?? '').replace(/\/$/, '');
  if (!event || !url) {
    root.appendChild(h('section', { class: 'panel' }, h('p', { class: 'alert alert-error' }, 'Falta el evento o el servidor en el enlace.'), button('Inicio', () => navigate('/'), 'btn')));
    return;
  }
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
