/** Iniciar sesión (#/login): usuario y contraseña; el servidor decide si es administrador o animador. */

import { button, clear, errorMessage, h, toast } from '../../dom.js';
import { navigate } from '../../router.js';
import { saveToken } from '../../concert/store.js';
import { api, currentServer, resolveServer, tokens } from '../api.js';

export async function renderLogin(root: HTMLElement, params: URLSearchParams): Promise<void> {
  clear(root);
  const server = await resolveServer(params.get('l'));
  const next = params.get('next') ?? '';
  const user = h('input', { class: 'input', type: 'text', placeholder: 'Usuario', autocomplete: 'username', required: true, autocapitalize: 'none' });
  const pass = h('input', { class: 'input', type: 'password', placeholder: 'Contraseña', autocomplete: 'current-password', required: true });
  const url = h('input', { class: 'input', type: 'url', value: server, placeholder: 'https://servidor-bingo-hit' });
  const submit = h('button', { class: 'btn btn-gold btn-lg', type: 'submit' }, 'Iniciar');
  const form = h(
    'form',
    { class: 'panel login-panel' },
    h('h1', null, '🎤 Iniciar sesión'),
    h('p', { class: 'muted' }, 'Acceso para animadores y administración de Bingo Hit.'),
    h('div', { class: 'fields' }, h('label', { class: 'field' }, 'Usuario', user), h('label', { class: 'field' }, 'Contraseña', pass)),
    server ? null : h('label', { class: 'field' }, 'Servidor', url),
    h('div', { class: 'actions' }, submit, button('Volver', () => navigate('/'), 'btn btn-link')),
    h('p', { class: 'small muted' }, '¿Vienes a jugar? No necesitas cuenta: abre el enlace o el QR de la partida.'),
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    try {
      if (!currentServer()) await resolveServer(url.value.trim());
      const r = await api<{ token: string; role: string; name: string }>('POST', '/api/auth/login', { body: { username: user.value.trim(), password: pass.value } });
      if (r.role === 'PLATFORM_ADMIN') {
        tokens.setAdmin(r.token);
        toast('Bienvenido, administrador', 'success');
        navigate(next || '/admin');
      } else {
        tokens.setHost(r.token);
        saveToken(r.token); // el mismo token sirve para transmitir (#/live) y para el panel de karaoke (#/dj)
        toast(`Hola, ${r.name}`, 'success');
        navigate(next || '/events');
      }
    } catch (err) {
      toast(errorMessage(err), 'error');
      submit.disabled = false;
    }
  });
  root.appendChild(form);
  user.focus();
}

/** Cierra la sesión en el servidor y borra los tokens locales. */
export async function logout(): Promise<void> {
  const token = tokens.host() || tokens.admin();
  if (token) await api('POST', '/api/auth/logout', { token }).catch(() => undefined);
  tokens.setHost('');
  tokens.setAdmin('');
  saveToken('');
  navigate('/');
}
