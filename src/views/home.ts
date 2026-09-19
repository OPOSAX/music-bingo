/** Pantalla inicial: configuración del Client ID, inicio de sesión y acceso a la partida. */

import * as auth from '../auth.js';
import { button, clear, copyText, errorMessage, h, toast } from '../dom.js';
import * as api from '../spotify-api.js';
import { clearGame, loadGame } from '../store.js';
import { navigate } from '../router.js';

let showClientIdForm = false;

export async function renderHome(root: HTMLElement): Promise<void> {
  clear(root);
  root.appendChild(
    h('section', { class: 'hero' }, h('h1', null, '🎵 Bingo musical'), h('p', { class: 'lead' }, 'Tu lista de Spotify, tus tarjetas, tu fiesta.')),
  );
  const version = h('p', { class: 'muted small center version' });
  root.appendChild(version);
  void fetch('version.txt', { cache: 'no-store' })
    .then((r) => (r.ok ? r.text() : ''))
    .then((v) => {
      if (v.trim()) version.textContent = `Versión ${v.trim()}`;
    })
    .catch(() => undefined);

  if (showClientIdForm || !auth.getClientId()) {
    root.appendChild(renderClientIdForm());
    root.appendChild(renderPlayerAccess());
    return;
  }

  if (!auth.isLoggedIn()) {
    root.appendChild(
      h(
        'section',
        { class: 'panel' },
        h('h2', null, 'Anfitrión'),
        h('p', null, 'Inicia sesión con tu cuenta de Spotify Premium para elegir la lista y reproducir las canciones.'),
        button('Conectar con Spotify', () => auth.login().catch((err) => toast(errorMessage(err), 'error')), 'btn btn-primary btn-lg'),
        h('p', { class: 'muted small' }, 'Client ID configurado: ', h('code', null, auth.getClientId()), ' ', button('Cambiar', () => { showClientIdForm = true; void renderHome(root); }, 'btn btn-link')),
      ),
    );
    root.appendChild(renderPlayerAccess());
    return;
  }

  const panel = h('section', { class: 'panel' }, h('h2', null, 'Anfitrión'), h('p', { class: 'muted' }, 'Comprobando tu cuenta…'));
  root.appendChild(panel);
  root.appendChild(renderPlayerAccess());

  try {
    const me = await api.getMe();
    clear(panel);
    const premium = me.product === 'premium';
    panel.appendChild(h('h2', null, 'Anfitrión'));
    panel.appendChild(
      h(
        'p',
        { class: 'user-line' },
        me.images?.[0] ? h('img', { class: 'avatar', src: me.images[0].url, alt: '' }) : null,
        h('span', null, 'Conectado como ', h('strong', null, me.display_name || me.id)),
        h('span', { class: premium ? 'badge badge-ok' : 'badge badge-warn' }, premium ? 'Premium' : me.product ?? 'sin premium'),
      ),
    );
    if (!premium) {
      panel.appendChild(
        h('p', { class: 'alert alert-warn' }, 'La reproducción en el navegador y el control remoto requieren Spotify Premium. Podrás preparar tarjetas, pero no reproducir las canciones.'),
      );
    }
    const missing = auth.missingScopes();
    if (missing.length) {
      panel.appendChild(h('p', { class: 'alert alert-warn' }, `Spotify no concedió estos permisos: ${missing.join(', ')}. Cierra sesión y vuelve a conectar aceptando todos los permisos.`));
    }
    panel.appendChild(h('p', { class: 'muted small' }, `Usuario ${me.id} · cuenta ${me.product ?? 'desconocida'} · permisos concedidos: ${auth.grantedScopes().length || '?'} de ${auth.SCOPES.length}`));
    const game = loadGame();
    const actions = h('div', { class: 'actions' });
    if (game) {
      actions.appendChild(button(`Continuar partida ${game.config.seed} (${game.position}/${game.tracks.length} canciones)`, () => navigate('/host'), 'btn btn-primary btn-lg'));
      actions.appendChild(button('Ver tarjetas', () => navigate('/cards'), 'btn'));
      actions.appendChild(
        button('Borrar partida', () => {
          if (confirm('¿Seguro que quieres borrar la partida actual? Las tarjetas dejarán de ser válidas.')) {
            clearGame();
            void renderHome(root);
          }
        }, 'btn btn-danger'),
      );
    }
    actions.appendChild(button(game ? 'Nueva partida' : 'Crear partida', () => navigate('/setup'), game ? 'btn' : 'btn btn-primary btn-lg'));
    actions.appendChild(button('Cerrar sesión', () => { auth.logout(); void renderHome(root); }, 'btn btn-link'));
    panel.appendChild(actions);
  } catch (err) {
    clear(panel);
    panel.appendChild(h('h2', null, 'Anfitrión'));
    panel.appendChild(h('p', { class: 'alert alert-error' }, errorMessage(err)));
    panel.appendChild(button('Volver a conectar con Spotify', () => { auth.logout(); auth.login().catch((e) => toast(errorMessage(e), 'error')); }, 'btn btn-primary'));
  }
}

function renderClientIdForm(): HTMLElement {
  const input = h('input', { class: 'input', type: 'text', placeholder: 'Client ID de tu app de Spotify', autocomplete: 'off', spellcheck: false, value: auth.getClientId() });
  const uri = auth.redirectUri();
  const form = h(
    'form',
    { class: 'panel' },
    h('h2', null, 'Primer paso: conecta tu app de Spotify'),
    h(
      'ol',
      { class: 'steps' },
      h('li', null, 'Entra en ', h('a', { href: 'https://developer.spotify.com/dashboard', target: '_blank', rel: 'noopener' }, 'developer.spotify.com/dashboard'), ' y crea una app (Create app).'),
      h('li', null, 'En "Redirect URIs" añade exactamente: ', h('code', { class: 'copyable' }, uri), ' ', button('Copiar', () => { void copyText(uri).then((ok) => toast(ok ? 'Copiado' : 'No se pudo copiar', ok ? 'success' : 'error')); }, 'btn btn-sm')),
      h('li', null, 'Marca "Web API" y "Web Playback SDK" y guarda.'),
      h('li', null, 'Copia el Client ID de la app y pégalo aquí.'),
    ),
    h('div', { class: 'row' }, input, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Guardar')),
    h('p', { class: 'muted small' }, 'El Client ID se guarda solo en este navegador. No hace falta client secret. ', auth.isUsingDefaultClientId() ? null : button('Volver al Client ID por defecto', () => { auth.setClientId(''); showClientIdForm = false; void renderHome(form.parentElement as HTMLElement); }, 'btn btn-link')),
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
    const root = form.parentElement as HTMLElement;
    void renderHome(root);
  });
  return form;
}

function renderPlayerAccess(): HTMLElement {
  const input = h('input', { class: 'input', type: 'text', placeholder: 'Pega aquí el enlace de tu tarjeta', autocomplete: 'off' });
  const form = h(
    'form',
    { class: 'panel' },
    h('h2', null, 'Jugador'),
    h('p', null, 'Escanea el código QR de tu tarjeta con la cámara del móvil, o si el anfitrión te ha enviado un enlace, pégalo aquí. No necesitas cuenta de Spotify.'),
    h('div', { class: 'row' }, input, h('button', { class: 'btn', type: 'submit' }, 'Abrir tarjeta')),
  );
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    const match = text.match(/#\/card\?d=([A-Za-z0-9_-]+)/) ?? text.match(/^([zj][A-Za-z0-9_-]+)$/);
    if (!match) {
      toast('No parece un enlace de tarjeta válido.', 'error');
      return;
    }
    navigate(`/card?d=${match[1]}`);
  });
  return form;
}
