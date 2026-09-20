/**
 * Panel del anfitrión "Quieren cantar": lista en vivo de los jugadores que pulsaron "Quiero cantar" en su tarjeta
 * (misma sala que la partida) y acceso al panel completo del DJ para dar paso a los micrófonos.
 */

import { button, clear, errorMessage, formatDuration, h } from '../../dom.js';
import { navigate } from '../../router.js';
import { DjClient } from '../dj-client.js';
import type { ParticipantInfo, ParticipantState } from '../protocol.js';
import { createSignaling, type ConcertEndpoint } from '../session.js';
import { loadConfig } from '../store.js';

let watcher: { dj: DjClient; room: string; off: () => void } | null = null;

export function releaseKaraokeWatch(): void {
  const w = watcher;
  watcher = null;
  if (!w) return;
  w.off();
  w.dj.disconnect();
}

const STATE_LABEL: Record<ParticipantState, string> = {
  DISCONNECTED: '🔴 sin conexión',
  CONNECTED: '⚪ conectado',
  READY: '🟢 quiere cantar',
  PREPARING: '🟡 preparando',
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
  const panel = h(
    'section',
    { class: 'panel karaoke-host' },
    h('div', { class: 'row space' }, h('h2', null, '🎤 Quieren cantar ', count), h('div', { class: 'actions' }, button('Abrir panel del DJ (micrófonos)', () => navigate(djPanelUrl(endpoint)), 'btn btn-sm btn-primary'))),
    h('p', { class: 'small muted' }, 'Los jugadores pulsan "Quiero cantar" en su tarjeta y aparecen aquí. Desde el panel del DJ preparas su micrófono y les das paso por el PA.'),
    list,
    status,
  );
  const draw = () => {
    if (!watcher) return;
    const items = [...watcher.dj.participants.values()].filter((p) => p.state !== 'DISCONNECTED' && p.state !== 'CONNECTED').sort(byPriority);
    count.textContent = String(items.length);
    clear(list);
    if (!items.length) list.appendChild(h('li', { class: 'muted small' }, 'Nadie se ha apuntado todavía.'));
    for (const p of items) {
      list.appendChild(
        h(
          'li',
          { class: `ready-row karaoke-row st-${p.state.toLowerCase()}` },
          h('div', { class: 'ready-info' }, h('strong', null, p.name), h('span', { class: 'small muted' }, [p.mesa, p.sector, p.asiento].filter(Boolean).join(' · ') || ''), h('span', { class: 'small muted' }, p.timestampReady ? ` · espera ${formatDuration(Date.now() - p.timestampReady)}` : '')),
          h('span', { class: 'small' }, STATE_LABEL[p.state] ?? p.state),
        ),
      );
    }
  };
  void (async () => {
    try {
      if (watcher && watcher.room !== endpoint.roomId) releaseKaraokeWatch();
      if (!watcher) {
        const signaling = await createSignaling(endpoint, 'dj', loadConfig());
        const dj = new DjClient(signaling, endpoint.roomId);
        await dj.connect('Anfitrión');
        const off = dj.onChange(draw);
        watcher = { dj, room: endpoint.roomId, off };
      } else {
        watcher.off();
        watcher.off = watcher.dj.onChange(draw);
      }
      status.textContent = `Sala ${endpoint.roomId} · ${endpoint.btalkUrl}`;
      draw();
    } catch (err) {
      status.textContent = `No se pudo conectar con la sala de karaoke: ${errorMessage(err)}`;
      status.className = 'alert alert-error small';
    }
  })();
  return panel;
}

function byPriority(a: ParticipantInfo, b: ParticipantInfo): number {
  const order: ParticipantState[] = ['LIVE', 'MUTED', 'PREPARED', 'PREPARING', 'READY', 'ERROR', 'CONNECTED', 'DISCONNECTED'];
  const d = order.indexOf(a.state) - order.indexOf(b.state);
  return d !== 0 ? d : (a.timestampReady ?? 0) - (b.timestampReady ?? 0);
}
