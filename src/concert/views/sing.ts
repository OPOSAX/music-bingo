/**
 * Karaoke del participante. El mismo widget se usa dentro de la tarjeta del jugador (botón "Quiero cantar")
 * y en la página independiente #/sing (enlace del DJ). Un botón para estar disponible y siempre uno para apagar.
 */

import { button, clear, errorMessage, h, toast } from '../../dom.js';
import { navigate } from '../../router.js';
import { ConcertMediaService } from '../media-service.js';
import { ParticipantClient, type ParticipantSnapshot } from '../participant-client.js';
import type { ParticipantState } from '../protocol.js';
import { createMediaAdapter, createSignaling, endpointFromParams, isDemo, type ConcertEndpoint } from '../session.js';
import { loadConfig, participantId, saveName, savedName } from '../store.js';

let client: ParticipantClient | null = null;
let clientRoom = '';
let wakeLock: { release(): Promise<void> } | null = null;

export async function releaseSing(): Promise<void> {
  const c = client;
  client = null;
  clientRoom = '';
  await wakeLock?.release().catch(() => undefined);
  wakeLock = null;
  await c?.disconnect().catch(() => undefined);
}

/** ¿Hay una sesión de karaoke abierta en esta sala? (permite conservarla al volver a pintar la tarjeta). */
export function karaokeActiveIn(roomId: string): boolean {
  return client !== null && clientRoom === roomId;
}

const STATE_UI: Record<ParticipantState, { icon: string; title: string; hint: string; cls: string }> = {
  DISCONNECTED: { icon: '🔴', title: 'Sin conexión', hint: 'Reconectando…', cls: 'st-off' },
  CONNECTED: { icon: '⚪', title: 'Conectado', hint: 'Pulsa QUIERO CANTAR para entrar en la lista del animador.', cls: 'st-idle' },
  READY: { icon: '🟢', title: 'En la lista para cantar', hint: 'El animador te avisará cuando te toque. Mantén la pantalla encendida.', cls: 'st-ready' },
  PREPARING: { icon: '🟡', title: 'Preparando tu micrófono', hint: 'Acepta el permiso de micrófono si te lo pide el navegador.', cls: 'st-prep' },
  PREPARED: { icon: '🟡', title: 'Listo, espera al animador', hint: 'Tu micrófono está preparado pero todavía NO suena.', cls: 'st-prep' },
  LIVE: { icon: '🔴', title: '¡EN VIVO!', hint: 'Tu voz está saliendo por el PA. Canta cerca del móvil.', cls: 'st-live' },
  MUTED: { icon: '🟠', title: 'Silenciado por el animador', hint: 'Tu micrófono sigue preparado, pero no suena.', cls: 'st-muted' },
  ERROR: { icon: '⚠️', title: 'Error', hint: 'Vuelve a pulsar QUIERO CANTAR para intentarlo de nuevo.', cls: 'st-off' },
};

/* ---------------- Página #/sing (enlace o QR del DJ) ---------------- */

export async function renderSing(root: HTMLElement, params: URLSearchParams): Promise<void> {
  clear(root);
  const config = loadConfig();
  const endpoint = endpointFromParams(params, config);
  root.appendChild(h('section', { class: 'hero' }, h('h1', null, '🎤 Karaoke'), h('p', { class: 'lead' }, 'Canta desde tu móvil cuando el animador te dé paso.')));
  if (isDemo(endpoint)) root.appendChild(h('p', { class: 'alert alert-warn small' }, 'Modo demo: sin servidor configurado, esta pantalla solo se comunica con el panel del DJ abierto en esta misma pestaña.'));
  root.appendChild(createKaraokePanel(endpoint, { askName: true }));
  root.appendChild(h('p', { class: 'center' }, button('Inicio', () => navigate('/'), 'btn btn-link')));
}

/* ---------------- Widget reutilizable ---------------- */

export interface KaraokePanelOptions {
  /** Nombre ya conocido (jugador con tarjeta); si falta se pide en el formulario. */
  name?: string;
  /** Pedir siempre nombre y mesa (página #/sing). */
  askName?: boolean;
  /** Versión compacta dentro de la tarjeta del jugador. */
  compact?: boolean;
}

/** Sección autocontenida: botón "Quiero cantar" → lista del animador → estado del micrófono, siempre con "Apagar" y "Salir". */
export function createKaraokePanel(endpoint: ConcertEndpoint, options: KaraokePanelOptions = {}): HTMLElement {
  const wrap = h('section', { class: `panel sing-panel${options.compact ? ' sing-compact' : ''}` });
  let offChange: (() => void) | null = null;
  const draw = () => {
    offChange?.();
    offChange = null;
    clear(wrap);
    wrap.className = `panel sing-panel${options.compact ? ' sing-compact' : ''}`;
    if (client && clientRoom === endpoint.roomId) {
      const c = client;
      const paint = (snap: ParticipantSnapshot) => drawStatus(wrap, c, snap, options, async () => {
        await releaseSing();
        draw();
      });
      paint(c.snapshot());
      offChange = c.onChange(paint);
      return;
    }
    wrap.appendChild(drawJoinForm(endpoint, options, draw));
  };
  draw();
  return wrap;
}

function drawJoinForm(endpoint: ConcertEndpoint, options: KaraokePanelOptions, onJoined: () => void): HTMLElement {
  const known = (options.name ?? '').trim() || savedName();
  const needName = options.askName || !known;
  const name = h('input', { class: 'input', type: 'text', placeholder: 'Tu nombre', value: known, maxLength: 40, autocomplete: 'name' });
  const seat = h('input', { class: 'input', type: 'text', placeholder: 'Mesa / sector (opcional)', maxLength: 20 });
  const submit = h('button', { class: `btn btn-primary ${options.compact ? 'btn-lg' : 'btn-xl'}`, type: 'submit' }, '🎤 QUIERO CANTAR');
  const form = h(
    'form',
    null,
    options.compact ? h('h3', null, '🎤 Karaoke') : h('h2', null, 'Apúntate para cantar'),
    h('p', { class: 'small muted' }, options.compact ? 'Pulsa y entrarás en la lista del animador; te avisará cuando te toque. Tu micrófono no se activa hasta entonces.' : 'Al pulsar QUIERO CANTAR entras en la lista del animador. Tu micrófono NO se activa hasta que te elija; entonces el navegador te pedirá permiso. Siempre podrás apagarlo con un botón. No se graba nada en tu móvil.'),
    needName ? h('div', { class: 'fields' }, h('label', { class: 'field' }, 'Nombre', name), h('label', { class: 'field' }, 'Mesa o sector', seat)) : h('div', { class: 'row' }, seat),
    submit,
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const value = name.value.trim();
    if (!value) {
      toast('Escribe tu nombre.', 'error');
      return;
    }
    saveName(value);
    submit.disabled = true;
    submit.textContent = 'Conectando…';
    try {
      await start(value, seat.value.trim(), endpoint);
      await client?.ready();
      toast('¡Estás en la lista para cantar!', 'success');
      onJoined();
    } catch (err) {
      toast(errorMessage(err), 'error');
      submit.disabled = false;
      submit.textContent = '🎤 QUIERO CANTAR';
    }
  });
  return form;
}

async function start(name: string, mesa: string, endpoint: ConcertEndpoint): Promise<void> {
  await releaseSing();
  const config = loadConfig();
  const signaling = await createSignaling(endpoint, 'participant', config);
  const adapter = await createMediaAdapter(endpoint, signaling, config);
  const media = new ConcertMediaService(adapter);
  const meta: { mesa?: string; device: string; userAgent: string } = { device: /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop', userAgent: navigator.userAgent.slice(0, 80) };
  if (mesa) meta.mesa = mesa;
  const stats = adapter instanceof Object && 'stats' in adapter ? async () => null : undefined;
  client = new ParticipantClient(signaling, media, { participantId: participantId(), roomId: endpoint.roomId, name, meta }, { heartbeatMs: 10_000, ...(stats ? { linkStats: stats } : {}) });
  clientRoom = endpoint.roomId;
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

function drawStatus(panel: HTMLElement, c: ParticipantClient, snap: ParticipantSnapshot, options: KaraokePanelOptions, onExit: () => Promise<void>): void {
  clear(panel);
  const ui = STATE_UI[snap.state];
  panel.className = `panel sing-panel ${ui.cls}${options.compact ? ' sing-compact' : ''}`;
  panel.appendChild(h('div', { class: 'sing-state' }, h('div', { class: 'sing-icon' }, ui.icon), h(options.compact ? 'h3' : 'h2', null, ui.title), h('p', { class: 'muted small' }, ui.hint)));
  if (snap.slotId) panel.appendChild(h('p', { class: 'badge badge-ok' }, `Micrófono ${snap.slotId.replace('MIC_', '')}`));
  if (snap.error) panel.appendChild(h('p', { class: 'alert alert-error small' }, snap.error));
  if (snap.state === 'LIVE') panel.appendChild(h('div', { class: 'live-pulse' }));
  const actions = h('div', { class: 'actions sing-actions' });
  const big = options.compact ? 'btn-lg' : 'btn-xl';
  if (snap.micActive || snap.state === 'PREPARING' || snap.state === 'PREPARED' || snap.state === 'LIVE' || snap.state === 'MUTED') {
    actions.appendChild(button('⏹ APAGAR MI MICRÓFONO', () => void c.stopMyMic().then(() => toast('Micrófono apagado', 'success'), (err) => toast(errorMessage(err), 'error')), `btn btn-danger ${big}`));
  } else if (snap.state === 'CONNECTED' || snap.state === 'ERROR') {
    actions.appendChild(button('🎤 QUIERO CANTAR', () => void c.ready().catch((err) => toast(errorMessage(err), 'error')), `btn btn-primary ${big}`));
  }
  actions.appendChild(button(options.compact ? 'Ya no quiero cantar' : 'SALIR', () => void onExit(), 'btn'));
  panel.appendChild(actions);
  panel.appendChild(h('p', { class: 'small muted center' }, `${c.identity.name} · `, snap.connected ? 'conectado' : 'sin conexión, reintentando…'));
}
