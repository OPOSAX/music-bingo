/** Pantalla del participante del karaoke. Un botón para estar disponible y siempre un botón para apagar. */

import { button, clear, errorMessage, h, toast } from '../../dom.js';
import { ConcertMediaService } from '../media-service.js';
import { ParticipantClient, type ParticipantSnapshot } from '../participant-client.js';
import type { ParticipantState } from '../protocol.js';
import { createMediaAdapter, createSignaling, endpointFromParams, isDemo } from '../session.js';
import { loadConfig, participantId, saveName, savedName } from '../store.js';

let client: ParticipantClient | null = null;
let wakeLock: { release(): Promise<void> } | null = null;

export async function releaseSing(): Promise<void> {
  const c = client;
  client = null;
  await wakeLock?.release().catch(() => undefined);
  wakeLock = null;
  await c?.disconnect().catch(() => undefined);
}

const STATE_UI: Record<ParticipantState, { icon: string; title: string; hint: string; cls: string }> = {
  DISCONNECTED: { icon: '🔴', title: 'Sin conexión', hint: 'Reconectando…', cls: 'st-off' },
  CONNECTED: { icon: '⚪', title: 'Conectado', hint: 'Pulsa ESTOY DISPONIBLE para entrar en la lista del DJ.', cls: 'st-idle' },
  READY: { icon: '🟢', title: 'Disponible', hint: 'Estás en la lista. Mantén la pantalla encendida; el DJ te avisará.', cls: 'st-ready' },
  PREPARING: { icon: '🟡', title: 'Preparando tu micrófono', hint: 'Acepta el permiso de micrófono si te lo pide el navegador.', cls: 'st-prep' },
  PREPARED: { icon: '🟡', title: 'Listo, espera al DJ', hint: 'Tu micrófono está preparado pero todavía NO suena.', cls: 'st-prep' },
  LIVE: { icon: '🔴', title: '¡EN VIVO!', hint: 'Tu voz está saliendo por el PA. Canta cerca del móvil.', cls: 'st-live' },
  MUTED: { icon: '🟠', title: 'Silenciado por el DJ', hint: 'Tu micrófono sigue preparado, pero no suena.', cls: 'st-muted' },
  ERROR: { icon: '⚠️', title: 'Error', hint: 'Vuelve a pulsar ESTOY DISPONIBLE para intentarlo de nuevo.', cls: 'st-off' },
};

export async function renderSing(root: HTMLElement, params: URLSearchParams): Promise<void> {
  clear(root);
  const config = loadConfig();
  const endpoint = endpointFromParams(params, config);
  root.appendChild(h('section', { class: 'hero' }, h('h1', null, '🎤 Karaoke'), h('p', { class: 'lead' }, 'Canta desde tu móvil cuando el DJ te dé paso.')));
  if (isDemo(endpoint)) root.appendChild(h('p', { class: 'alert alert-warn small' }, 'Modo demo: sin servidor B-Talk configurado, esta pantalla solo se comunica con el panel del DJ abierto en esta misma pestaña.'));

  if (!client) {
    root.appendChild(renderNameForm(root, params));
    return;
  }
  root.appendChild(renderStatus(root));
}

function renderNameForm(root: HTMLElement, params: URLSearchParams): HTMLElement {
  const name = h('input', { class: 'input', type: 'text', placeholder: 'Tu nombre', value: savedName(), maxLength: 40, autocomplete: 'name' });
  const seat = h('input', { class: 'input', type: 'text', placeholder: 'Mesa / sector (opcional)', maxLength: 20 });
  const form = h(
    'form',
    { class: 'panel' },
    h('h2', null, 'Apúntate'),
    h(
      'p',
      { class: 'small muted' },
      'Al pulsar ESTOY DISPONIBLE entras en la lista del DJ. Tu micrófono NO se activa hasta que el DJ te elija; entonces el navegador te pedirá permiso. ',
      'Siempre podrás apagarlo con un botón. No se graba nada en tu móvil.',
    ),
    h('div', { class: 'fields' }, h('label', { class: 'field' }, 'Nombre', name), h('label', { class: 'field' }, 'Mesa o sector', seat)),
    h('button', { class: 'btn btn-primary btn-xl', type: 'submit' }, '🟢 ESTOY DISPONIBLE'),
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const value = name.value.trim();
    if (!value) {
      toast('Escribe tu nombre.', 'error');
      return;
    }
    saveName(value);
    const submit = form.querySelector('button[type=submit]') as HTMLButtonElement;
    submit.disabled = true;
    submit.textContent = 'Conectando…';
    try {
      await start(value, seat.value.trim(), params);
      await client?.ready();
      await renderSing(root, params);
    } catch (err) {
      toast(errorMessage(err), 'error');
      submit.disabled = false;
      submit.textContent = '🟢 ESTOY DISPONIBLE';
    }
  });
  return form;
}

async function start(name: string, mesa: string, params: URLSearchParams): Promise<void> {
  const config = loadConfig();
  const endpoint = endpointFromParams(params, config);
  const signaling = await createSignaling(endpoint, 'participant', config);
  const adapter = await createMediaAdapter(endpoint, signaling, config);
  const media = new ConcertMediaService(adapter);
  const meta: { mesa?: string; device: string; userAgent: string } = { device: /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop', userAgent: navigator.userAgent.slice(0, 80) };
  if (mesa) meta.mesa = mesa;
  const stats = adapter instanceof Object && 'stats' in adapter ? async () => null : undefined;
  client = new ParticipantClient(signaling, media, { participantId: participantId(), roomId: endpoint.roomId, name, meta }, { heartbeatMs: 10_000, ...(stats ? { linkStats: stats } : {}) });
  await client.connect();
  await requestWakeLock();
}

async function requestWakeLock(): Promise<void> {
  const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
  try {
    wakeLock = (await nav.wakeLock?.request('screen')) ?? null;
  } catch {
    wakeLock = null;
  }
}

function renderStatus(root: HTMLElement): HTMLElement {
  const c = client as ParticipantClient;
  const panel = h('section', { class: 'panel sing-panel' });
  const draw = (snap: ParticipantSnapshot) => {
    clear(panel);
    const ui = STATE_UI[snap.state];
    panel.className = `panel sing-panel ${ui.cls}`;
    panel.appendChild(h('div', { class: 'sing-state' }, h('div', { class: 'sing-icon' }, ui.icon), h('h2', null, ui.title), h('p', { class: 'muted' }, ui.hint)));
    if (snap.slotId) panel.appendChild(h('p', { class: 'badge badge-ok' }, `Micrófono ${snap.slotId.replace('MIC_', '')}`));
    if (snap.error) panel.appendChild(h('p', { class: 'alert alert-error small' }, snap.error));
    if (snap.state === 'LIVE') panel.appendChild(h('div', { class: 'live-pulse' }));
    const actions = h('div', { class: 'actions sing-actions' });
    if (snap.micActive || snap.state === 'PREPARING' || snap.state === 'PREPARED' || snap.state === 'LIVE' || snap.state === 'MUTED') {
      actions.appendChild(button('⏹ APAGAR MI MICRÓFONO', () => void c.stopMyMic().then(() => toast('Micrófono apagado', 'success'), (err) => toast(errorMessage(err), 'error')), 'btn btn-danger btn-xl'));
    } else if (snap.state === 'CONNECTED' || snap.state === 'ERROR') {
      actions.appendChild(button('🟢 ESTOY DISPONIBLE', () => void c.ready().catch((err) => toast(errorMessage(err), 'error')), 'btn btn-primary btn-xl'));
    }
    actions.appendChild(
      button(
        'SALIR',
        async () => {
          await releaseSing();
          await renderSing(root, new URLSearchParams(location.hash.split('?')[1] ?? ''));
        },
        'btn',
      ),
    );
    panel.appendChild(actions);
    panel.appendChild(h('p', { class: 'small muted center' }, `Hola, ${c.identity.name}. `, snap.connected ? 'Conectado.' : 'Sin conexión, reintentando…'));
  };
  draw(c.snapshot());
  c.onChange(draw);
  return panel;
}
