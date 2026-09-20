/** Pantalla inicial: configuración del Client ID, inicio de sesión y acceso a la partida. */

import * as auth from '../auth.js';
import { button, clear, copyText, errorMessage, h, toast } from '../dom.js';
import * as api from '../spotify-api.js';
import { clearGame, loadGame } from '../store.js';
import { navigate } from '../router.js';

let showClientIdForm = false;

export async function renderHome(root: HTMLElement): Promise<void> {
  clear(root);
  root.appendChild(renderLanding());
  const version = h('p', { class: 'muted small center version' });
  root.appendChild(version);
  void fetch('version.txt', { cache: 'no-store' })
    .then((r) => (r.ok ? r.text() : ''))
    .then((v) => {
      if (v.trim()) version.textContent = `Versión ${v.trim()}`;
    })
    .catch(() => undefined);
}

/** Acceso del jugador (#/jugar): abrir una tarjeta o un enlace de partida. */
export async function renderPlayerEntry(root: HTMLElement): Promise<void> {
  clear(root);
  root.appendChild(h('section', { class: 'page-header' }, h('h1', null, '📱 Jugar'), h('div', { class: 'actions' }, button('Inicio', () => navigate('/'), 'btn btn-link'))));
  root.appendChild(renderPlayerAccess());
  root.appendChild(
    h('section', { class: 'panel' }, h('h2', null, '🎤 Karaoke'), h('p', { class: 'muted' }, 'Cuando abras tu tarjeta encontrarás el botón "Quiero cantar": entras en la lista del animador y él te da paso al micrófono desde tu propio móvil.')),
  );
}

/** Partida musical con Spotify: conexión de la cuenta y creación/continuación de la partida (dentro del panel del animador). */
export async function renderSpotifyPanel(root: HTMLElement): Promise<void> {
  const wrap = h('div');
  root.appendChild(wrap);
  await drawSpotifyPanel(wrap);
}

async function drawSpotifyPanel(wrap: HTMLElement): Promise<void> {
  clear(wrap);
  const panel = h('section', { class: 'panel' }, h('h2', null, '🎵 Partida musical (Spotify)'));
  wrap.appendChild(panel);
  const again = () => void drawSpotifyPanel(wrap);
  if (showClientIdForm || !auth.getClientId()) {
    panel.appendChild(renderClientIdForm(again));
    return;
  }
  if (!auth.isLoggedIn()) {
    panel.appendChild(h('p', null, 'Conecta la cuenta de Spotify Premium que reproducirá la música del evento.'));
    panel.appendChild(button('Conectar con Spotify', () => auth.login().catch((err) => toast(errorMessage(err), 'error')), 'btn btn-primary btn-lg'));
    panel.appendChild(h('p', { class: 'muted small' }, 'Client ID: ', h('code', null, auth.getClientId()), ' ', button('Cambiar', () => { showClientIdForm = true; again(); }, 'btn btn-link')));
    return;
  }
  const status = h('p', { class: 'muted' }, 'Comprobando tu cuenta…');
  panel.appendChild(status);
  try {
    const me = await api.getMe();
    const premium = me.product === 'premium';
    status.replaceWith(
      h(
        'p',
        { class: 'user-line' },
        me.images?.[0] ? h('img', { class: 'avatar', src: me.images[0].url, alt: '' }) : null,
        h('span', null, 'Conectado como ', h('strong', null, me.display_name || me.id), premium ? h('span', { class: 'badge badge-ok' }, 'Premium') : h('span', { class: 'badge badge-warn' }, 'Sin Premium')),
      ),
    );
    if (!premium) panel.appendChild(h('p', { class: 'alert alert-warn' }, 'La reproducción necesita Spotify Premium.'));
    const missing = auth.missingScopes();
    if (missing.length) panel.appendChild(h('p', { class: 'alert alert-warn' }, `Spotify no concedió estos permisos: ${missing.join(', ')}. Cierra sesión y vuelve a conectar aceptando todos los permisos.`));
    const game = loadGame();
    const actions = h('div', { class: 'actions' });
    if (game) {
      actions.appendChild(button(`Continuar: ${game.playlistName}`, () => navigate('/host'), 'btn btn-primary'));
      actions.appendChild(button('Nueva partida', () => { if (confirm('¿Descartar la partida actual y crear otra?')) { clearGame(); navigate('/setup'); } }, 'btn'));
    } else {
      actions.appendChild(button('Crear partida', () => navigate('/setup'), 'btn btn-primary'));
    }
    actions.appendChild(button('Cerrar sesión de Spotify', () => { auth.logout(); again(); }, 'btn btn-link'));
    panel.appendChild(actions);
  } catch (err) {
    status.textContent = '';
    panel.appendChild(h('p', { class: 'alert alert-error' }, errorMessage(err)));
    panel.appendChild(button('Volver a conectar', () => { auth.logout(); again(); }, 'btn'));
  }
}

/** Portada de marca: qué es Bingo Hit, para quién y cómo se juega. */
function renderLanding(): HTMLElement {
  const feature = (icon: string, title: string) => h('div', { class: 'bh-feature' }, h('span', { class: 'bh-feature-icon' }, icon), h('span', null, title));
  return h(
    'section',
    { class: 'bh-hero' },
    h('div', { class: 'bh-hero-bg' }),
    h(
      'div',
      { class: 'bh-hero-body' },
      h('p', { class: 'bh-kicker' }, 'Buena música · Mejores momentos'),
      h('h1', { class: 'bh-title' }, h('span', null, 'BINGO '), h('span', { class: 'bh-gold' }, 'HIT')),
      h('p', { class: 'bh-sub' }, 'Music Bingo & Karaoke'),
      h('p', { class: 'bh-tagline' }, 'La música se transforma en juego'),
      h(
        'p',
        { class: 'bh-desc' },
        h('strong', null, 'Bingo HIT'),
        ' es una experiencia de entretenimiento musical interactivo que combina ',
        h('strong', null, 'bingo musical'),
        ', ',
        h('strong', null, 'karaoke'),
        ' y ',
        h('strong', null, 'participación en vivo'),
        ' desde el celular. Ideal para bares, pubs, restaurantes, hoteles, eventos y activaciones de marca.',
      ),
      h('div', { class: 'bh-features' }, feature('📱', 'Participación desde el celular'), feature('🎵', 'Bingo musical en vivo'), feature('🎤', 'Modo karaoke integrado'), feature('🏆', 'Premios, rondas y desafíos')),
      h(
        'div',
        { class: 'bh-actions' },
        button('Iniciar', () => navigate('/login'), 'btn btn-gold btn-lg'),
        button('📱 Tengo un enlace o QR', () => navigate('/jugar'), 'btn btn-outline-gold'),
      ),
      h('p', { class: 'bh-claim' }, 'Escucha. Juega. Canta. Gana.'),
      h('p', { class: 'bh-claim-sub' }, 'Más que música, es conexión'),
    ),
  );
}

function renderPlayerAccess(): HTMLElement {
  const input = h('input', { class: 'input', type: 'text', placeholder: 'Pega aquí el enlace de tu tarjeta', autocomplete: 'off' });
  const form = h(
    'form',
    { class: 'panel', id: 'jugador' },
    h('h2', null, 'Jugador'),
    h('p', null, 'Escanea el código QR de tu tarjeta con la cámara del móvil, o si el anfitrión te ha enviado un enlace, pégalo aquí. No necesitas cuenta de Spotify.'),
    h('div', { class: 'row' }, input, h('button', { class: 'btn', type: 'submit' }, 'Abrir tarjeta')),
  );
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    const joinMatch = text.match(/#\/join\?d=([A-Za-z0-9_-]+)/);
    if (joinMatch) {
      navigate(`/join?d=${joinMatch[1]}`);
      return;
    }
    const match = text.match(/#\/card\?d=([A-Za-z0-9_-]+)/) ?? text.match(/^([zj][A-Za-z0-9_-]+)$/);
    if (!match) {
      toast('No parece un enlace de tarjeta válido.', 'error');
      return;
    }
    navigate(`/card?d=${match[1]}`);
  });
  return form;
}

/** Formulario del Client ID de Spotify; `onSaved` se llama al guardar o al volver al valor por defecto. */
function renderClientIdForm(onSaved: () => void): HTMLElement {
  const input = h('input', { class: 'input', type: 'text', placeholder: 'Client ID de tu app de Spotify', autocomplete: 'off', spellcheck: false, value: auth.getClientId() });
  const uri = auth.redirectUri();
  const form = h(
    'form',
    { class: 'client-id-form' },
    h('h3', null, 'Conecta tu app de Spotify'),
    h(
      'ol',
      { class: 'steps' },
      h('li', null, 'Entra en ', h('a', { href: 'https://developer.spotify.com/dashboard', target: '_blank', rel: 'noopener' }, 'developer.spotify.com/dashboard'), ' y crea una app (Create app).'),
      h('li', null, 'En "Redirect URIs" añade exactamente: ', h('code', { class: 'copyable' }, uri), ' ', button('Copiar', () => { void copyText(uri).then((ok) => toast(ok ? 'Copiado' : 'No se pudo copiar', ok ? 'success' : 'error')); }, 'btn btn-sm')),
      h('li', null, 'Marca "Web API" y "Web Playback SDK" y guarda.'),
      h('li', null, 'Copia el Client ID de la app y pégalo aquí.'),
    ),
    h('div', { class: 'row' }, input, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Guardar')),
    h('p', { class: 'muted small' }, 'El Client ID se guarda solo en este navegador. No hace falta client secret. ', auth.isUsingDefaultClientId() ? null : button('Volver al Client ID por defecto', () => { auth.setClientId(''); showClientIdForm = false; onSaved(); }, 'btn btn-link')),
  );
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const value = input.value.trim();
    if (!/^[a-f0-9]{32}$/i.test(value)) {
      toast('El Client ID debe tener 32 caracteres hexadecimales.', 'error');
      return;
    }
    auth.setClientId(value);
    showClientIdForm = false;
    toast('Client ID guardado', 'success');
    onSaved();
  });
  return form;
}
