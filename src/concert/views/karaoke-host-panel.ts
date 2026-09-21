/**
 * Panel del anfitrión "Quieren cantar": los jugadores pulsan "Quiero cantar" en su tarjeta (misma sala que la partida)
 * y aparecen aquí. Con un solo botón el anfitrión autoriza: el servidor prepara el micrófono del teléfono, al estar
 * listo lo pone en vivo y el audio suena por este equipo. Silenciar y Terminar siempre a mano. El panel del DJ sigue
 * disponible para el control avanzado (mezclador, cancelación de eco, varios micrófonos).
 */

import { button, clear, errorMessage, formatDuration, h, toast } from '../../dom.js';
import { navigate } from '../../router.js';
import type { ConsumerAdapter } from '../consumer.js';
import { DjClient } from '../dj-client.js';
import { EVENTS, type ParticipantInfo, type ParticipantState } from '../protocol.js';
import { createConsumerAdapter, createSignaling, type ConcertEndpoint } from '../session.js';
import { loadConfig } from '../store.js';

interface Watcher {
  dj: DjClient;
  room: string;
  offs: (() => void)[];
  /** Autorizados por el anfitrión: al quedar PREPARED pasan a LIVE automáticamente. */
  autoLive: Set<string>;
  consumer: ConsumerAdapter | null;
  ctx: AudioContext | null;
  playing: Map<string, { stop(): void }>; // producerId → salida de audio
}

let watcher: Watcher | null = null;

export function releaseKaraokeWatch(): void {
  const w = watcher;
  watcher = null;
  if (!w) return;
  w.offs.forEach((off) => off());
  for (const p of w.playing.values()) p.stop();
  w.playing.clear();
  w.consumer?.closeAll();
  void w.ctx?.close().catch(() => undefined);
  w.dj.disconnect();
}

const STATE_LABEL: Record<ParticipantState, string> = {
  DISCONNECTED: '🔴 sin conexión',
  CONNECTED: '⚪ conectado',
  READY: '🟢 quiere cantar',
  PREPARING: '🟡 preparando su micrófono…',
  PREPARED: '🟡 micrófono listo',
  LIVE: '🔴 EN VIVO',
  MUTED: '🟠 silenciado',
  ERROR: '⚠️ error',
};

/** URL del panel completo del DJ para esta sala (mismo servidor y token del animador). */
export function djPanelUrl(endpoint: ConcertEndpoint): string {
  const params = new URLSearchParams({ btalk: endpoint.btalkUrl, room: endpoint.roomId });
  if (endpoint.token) params.set('token', endpoint.token);
  return `/dj?${params.toString()}`;
}

export function renderKaraokeHostPanel(endpoint: ConcertEndpoint): HTMLElement {
  const list = h('ul', { class: 'ready-list karaoke-list' });
  const count = h('span', { class: 'badge badge-ok' }, '0');
  const status = h('p', { class: 'small muted' }, 'Conectando con la sala…');
  const audioNote = h('p', { class: 'small muted' }, '🔊 El micrófono autorizado suena por la salida de audio de este equipo. Para mezclador, cancelación de eco o varios micrófonos usa el panel del DJ.');
  const panel = h(
    'section',
    { class: 'panel karaoke-host' },
    h('div', { class: 'row space' }, h('h2', null, '🎤 Quieren cantar ', count), h('div', { class: 'actions' }, button('Panel del DJ', () => navigate(djPanelUrl(endpoint)), 'btn btn-sm'))),
    h('p', { class: 'small muted' }, 'Los jugadores pulsan "Quiero cantar" en su tarjeta y aparecen aquí. Pulsa Autorizar para tomar su micrófono y sacar su voz por el PA.'),
    list,
    audioNote,
    status,
  );
  const draw = () => {
    const w = watcher;
    if (!w) return;
    const items = [...w.dj.participants.values()].filter((p) => p.state !== 'DISCONNECTED' && p.state !== 'CONNECTED').sort(byPriority);
    count.textContent = String(items.length);
    clear(list);
    if (!items.length) list.appendChild(h('li', { class: 'muted small' }, 'Nadie se ha apuntado todavía.'));
    const freeSlots = w.dj.slots.filter((s) => s.state === 'EMPTY').length;
    for (const p of items) {
      const actions = h('div', { class: 'actions' });
      const cmd = (label: string, fn: () => Promise<void>, cls = 'btn btn-sm') => button(label, () => void fn().catch((err) => toast(errorMessage(err), 'error')), cls);
      if (p.state === 'READY' || p.state === 'ERROR') {
        actions.appendChild(cmd('🎤 Autorizar', () => authorize(w, p.participantId), 'btn btn-sm btn-primary'));
        if (!freeSlots) actions.appendChild(h('span', { class: 'small muted' }, 'sin micrófono libre: termina uno'));
      } else if (p.state === 'PREPARING' || p.state === 'PREPARED') {
        actions.appendChild(cmd('Cancelar', () => w.dj.end(p.participantId)));
      } else if (p.state === 'LIVE') {
        actions.appendChild(cmd('🔇 Silenciar', () => w.dj.mute(p.participantId)));
        actions.appendChild(cmd('■ Terminar', () => w.dj.end(p.participantId), 'btn btn-sm btn-danger'));
      } else if (p.state === 'MUTED') {
        actions.appendChild(cmd('🔊 Reactivar', () => w.dj.unmute(p.participantId), 'btn btn-sm btn-primary'));
        actions.appendChild(cmd('■ Terminar', () => w.dj.end(p.participantId), 'btn btn-sm btn-danger'));
      }
      list.appendChild(
        h(
          'li',
          { class: `ready-row karaoke-row st-${p.state.toLowerCase()}` },
          h('div', { class: 'ready-info' }, h('strong', null, p.name), h('span', { class: 'small muted' }, [p.mesa, p.sector, p.asiento].filter(Boolean).join(' · ') || ''), h('span', { class: 'small muted' }, p.state === 'READY' && p.timestampReady ? ` · espera ${formatDuration(Date.now() - p.timestampReady)}` : ''), h('span', { class: 'small karaoke-state' }, ` ${STATE_LABEL[p.state] ?? p.state}`)),
          actions,
        ),
      );
    }
    void syncAudio(w);
  };
  void (async () => {
    try {
      if (watcher && watcher.room !== endpoint.roomId) releaseKaraokeWatch();
      if (!watcher) {
        const signaling = await createSignaling(endpoint, 'dj', loadConfig());
        const dj = new DjClient(signaling, endpoint.roomId);
        await dj.connect('Anfitrión');
        const w: Watcher = { dj, room: endpoint.roomId, offs: [], autoLive: new Set(), consumer: null, ctx: null, playing: new Map() };
        w.offs.push(dj.onChange(draw));
        // Autorizado por el anfitrión: en cuanto el teléfono está preparado, GO LIVE sin más clics.
        w.offs.push(
          signaling.on(EVENTS.prepared, (p: { participantId: string }) => {
            if (!w.autoLive.delete(p.participantId)) return;
            void dj.goLive(p.participantId).catch((err) => toast(errorMessage(err), 'error'));
          }),
        );
        w.offs.push(signaling.on(EVENTS.prepareFailed, (p: { participantId: string; reason: string }) => {
          w.autoLive.delete(p.participantId);
          toast(`${dj.participants.get(p.participantId)?.name ?? 'El participante'} no pudo activar su micrófono (${p.reason})`, 'error');
        }));
        try {
          w.consumer = await createConsumerAdapter(endpoint, signaling, () => w.ctx);
        } catch (err) {
          audioNote.textContent = `No se podrá escuchar el micrófono desde este equipo: ${errorMessage(err)}. Usa el panel del DJ.`;
        }
        watcher = w;
        const tick = setInterval(() => (panel.isConnected ? draw() : clearInterval(tick)), 1000);
        w.offs.push(() => clearInterval(tick));
      } else {
        watcher.offs.push(watcher.dj.onChange(draw));
      }
      status.textContent = `Sala ${endpoint.roomId} · ${endpoint.btalkUrl || 'demo local'}`;
      draw();
    } catch (err) {
      status.textContent = `No se pudo conectar con la sala de karaoke: ${errorMessage(err)}`;
      status.className = 'alert alert-error small';
    }
  })();
  return panel;
}

/** Autorizar = tomar el micrófono: PREPARE en un slot libre y GO LIVE automático cuando el teléfono esté listo. */
async function authorize(w: Watcher, participantId: string): Promise<void> {
  const slot = w.dj.slots.find((s) => s.state === 'EMPTY');
  if (!slot) throw new Error('No hay micrófono libre: termina uno de los que están en vivo.');
  ensureAudio(w); // el clic del anfitrión permite crear el contexto de audio del navegador
  w.autoLive.add(participantId);
  try {
    await w.dj.prepare(participantId, slot.slotId);
  } catch (err) {
    w.autoLive.delete(participantId);
    throw err;
  }
  toast(`${w.dj.participants.get(participantId)?.name ?? 'Participante'}: preparando su micrófono…`, 'info');
}

function ensureAudio(w: Watcher): void {
  if (w.ctx) {
    if (w.ctx.state === 'suspended') void w.ctx.resume().catch(() => undefined);
    return;
  }
  const Ctx = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  w.ctx = new Ctx();
}

/** Reproduce por este equipo los micrófonos preparados o en vivo; cierra los que terminaron. */
async function syncAudio(w: Watcher): Promise<void> {
  if (!w.consumer) return;
  const active = new Set<string>();
  for (const slot of w.dj.slots) if (slot.producerId && (slot.state === 'PREPARED' || slot.state === 'LIVE' || slot.state === 'MUTED')) active.add(slot.producerId);
  for (const [producerId, out] of [...w.playing]) {
    if (active.has(producerId)) continue;
    out.stop();
    w.consumer.close(producerId);
    w.playing.delete(producerId);
  }
  if (!w.ctx) return;
  for (const producerId of active) {
    if (w.playing.has(producerId)) continue;
    const placeholder = { stop: () => undefined };
    w.playing.set(producerId, placeholder);
    try {
      const source = await w.consumer.consume(producerId);
      if (watcher !== w || w.playing.get(producerId) !== placeholder) return;
      const ctx = w.ctx;
      if (source instanceof MediaStream) {
        // Un elemento <audio> mantiene viva la pista WebRTC; el AudioContext la saca por la salida por defecto.
        const el = new Audio();
        el.srcObject = source;
        el.muted = true;
        void el.play().catch(() => undefined);
        const node = ctx.createMediaStreamSource(source);
        node.connect(ctx.destination);
        w.playing.set(producerId, { stop: () => { node.disconnect(); el.pause(); el.srcObject = null; } });
      } else {
        source.connect(ctx.destination);
        w.playing.set(producerId, { stop: () => source.disconnect() });
      }
    } catch (err) {
      w.playing.delete(producerId);
      toast(`No se pudo recibir el micrófono: ${errorMessage(err)}`, 'error');
    }
  }
}

function byPriority(a: ParticipantInfo, b: ParticipantInfo): number {
  const order: ParticipantState[] = ['LIVE', 'MUTED', 'PREPARED', 'PREPARING', 'READY', 'ERROR', 'CONNECTED', 'DISCONNECTED'];
  const d = order.indexOf(a.state) - order.indexOf(b.state);
  return d !== 0 ? d : (a.timestampReady ?? 0) - (b.timestampReady ?? 0);
}
