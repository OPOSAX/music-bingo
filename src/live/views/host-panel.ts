/** Panel "Bingo Hit Live" dentro de la pantalla del anfitrión: activar el servidor Live y abrir el panel del animador. */

import { button, h, toast } from '../../dom.js';
import { navigate } from '../../router.js';
import type { GameState } from '../../store.js';
import { detectConcertServer } from '../../concert/session.js';
import { loadToken, saveToken } from '../../concert/store.js';
import type { LiveLink } from '../../sync.js';

export function liveLinkOf(game: GameState): LiveLink | undefined {
  return game.liveServer ? { url: game.liveServer, event: game.config.seed } : undefined;
}

export function renderLiveHostPanel(game: GameState, onChange: (activated: boolean) => void): HTMLElement {
  const url = h('input', { class: 'input', type: 'url', value: game.liveServer ?? '', placeholder: 'https://servidor-live (se detecta solo si sirve esta app)' });
  const token = h('input', { class: 'input', type: 'password', value: loadToken(), placeholder: 'Token del animador (LIVE_HOST_TOKEN)', autocomplete: 'off' });
  const status = h('p', { class: 'small' });
  const panel = h('section', { class: 'panel live-panel' }, h('h2', null, '🔴 Bingo Hit Live'), h('p', { class: 'muted small' }, 'Transmite cámara, micrófono y audio del evento a los jugadores dentro de su cartón. El estado de la partida viaja por el servidor Live (WebSocket) y el vídeo por WebRTC.'));
  const form = h('form', null, h('div', { class: 'fields' }, h('label', { class: 'field' }, 'Servidor Live', url), h('label', { class: 'field' }, 'Token del animador', token)));
  const activate = h('button', { class: 'btn btn-primary', type: 'submit' }, game.liveServer ? 'Guardar' : 'Activar Live');
  const openBtn = button('🎥 Abrir panel del animador', () => navigate(`/live?event=${encodeURIComponent(game.config.seed)}`), 'btn');
  const offBtn = button('Desactivar', () => {
    game.liveServer = undefined;
    onChange(false);
    render();
  }, 'btn btn-link');
  form.appendChild(h('div', { class: 'actions' }, activate, openBtn, offBtn));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const clean = url.value.trim().replace(/\/$/, '');
    if (!clean) {
      toast('Indica la URL del servidor Live.', 'error');
      return;
    }
    saveToken(token.value);
    game.liveServer = clean;
    onChange(true);
    toast('Bingo Hit Live activado: el QR de la partida ya lleva a los jugadores al evento en directo.', 'success');
    render();
  });
  const render = () => {
    const on = !!game.liveServer;
    status.textContent = on ? `Activo en ${game.liveServer} · sala bingo-${game.config.seed}` : 'Inactivo: los jugadores usan el canal ntfy.';
    status.className = on ? 'ok small' : 'muted small';
    openBtn.hidden = !on;
    offBtn.hidden = !on;
    activate.textContent = on ? 'Guardar' : 'Activar Live';
  };
  render();
  panel.appendChild(form);
  panel.appendChild(status);
  if (!game.liveServer) {
    void detectConcertServer().then((detected) => {
      if (detected && !url.value) url.value = detected;
    });
  }
  return panel;
}
