/** Panel del animador (/live): vista previa, dispositivos, iniciar/detener transmisión, estado, bingos y métricas. */

import { cardLabel } from '../../bingo.js';
import { button, clear, errorMessage, h, toast } from '../../dom.js';
import { navigate } from '../../router.js';
import { loadGame, type GameState } from '../../store.js';
import { detectConcertServer } from '../../concert/session.js';
import { loadToken, saveToken } from '../../concert/store.js';
import { renderKaraokeHostPanel } from '../../concert/views/karaoke-host-panel.js';
import { LIVE_EVENTS, liveRoomId, type BingoClaimed, type LinkState, type LiveMetrics } from '../protocol.js';
import { LiveHostPublisher, type DeviceLists } from '../publisher.js';
import { liveSession, releaseLiveSessions, type LiveSession } from '../session.js';

let publisher: LiveHostPublisher | null = null;
let timers: ReturnType<typeof setInterval>[] = [];
let offs: (() => void)[] = [];

export async function releaseLiveHost(): Promise<void> {
  timers.forEach(clearInterval);
  timers = [];
  offs.forEach((off) => off());
  offs = [];
  const p = publisher;
  publisher = null;
  await p?.stop().catch(() => undefined);
  releaseLiveSessions();
}

export async function renderLiveHost(root: HTMLElement, params: URLSearchParams): Promise<void> {
  clear(root);
  await releaseLiveHost();
  const game = loadGame();
  const eventId = params.get('event') ?? game?.config.seed ?? '';
  if (!eventId) {
    root.appendChild(h('section', { class: 'panel' }, h('p', { class: 'alert alert-error' }, 'No hay ninguna partida. Crea una partida y activa Bingo Hit Live desde la pantalla del anfitrión.'), button('Inicio', () => navigate('/'), 'btn')));
    return;
  }
  const serverUrl = params.get('l') ?? game?.liveServer ?? (await detectConcertServer()) ?? '';
  const token = params.get('token') ?? loadToken();
  root.appendChild(h('section', { class: 'page-header' }, h('div', null, h('h1', null, '🔴 Bingo Hit Live · animador'), h('p', { class: 'muted' }, `${game?.playlistName ?? 'Evento'} · evento ${eventId} · sala ${liveRoomId(eventId)}`)), h('div', { class: 'actions' }, button('Panel de la partida', () => navigate('/host'), 'btn'))));
  if (!serverUrl || !token) {
    root.appendChild(renderSetup(root, params, serverUrl, token));
    return;
  }
  const session = liveSession({ url: serverUrl, event: eventId }, { token, name: 'Animador' });
  renderPanel(root, session, game, eventId);
  root.appendChild(renderKaraokeHostPanel({ btalkUrl: serverUrl, roomId: liveRoomId(eventId), token }));
}

function renderSetup(root: HTMLElement, params: URLSearchParams, serverUrl: string, token: string): HTMLElement {
  const url = h('input', { class: 'input', type: 'url', value: serverUrl, placeholder: 'https://servidor-live' });
  const tok = h('input', { class: 'input', type: 'password', value: token, placeholder: 'Token del animador (LIVE_HOST_TOKEN)', autocomplete: 'off' });
  const form = h('form', { class: 'panel' }, h('h2', null, 'Conectar con el servidor Live'), h('div', { class: 'fields' }, h('label', { class: 'field' }, 'Servidor', url), h('label', { class: 'field' }, 'Token', tok)), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Continuar'));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    saveToken(tok.value);
    const next = new URLSearchParams(params);
    next.set('l', url.value.trim().replace(/\/$/, ''));
    location.hash = `#/live?${next.toString()}`;
  });
  return form;
}

function renderPanel(root: HTMLElement, session: LiveSession, game: GameState | null, eventId: string): void {
  const pub = new LiveHostPublisher(session, { rawAudio: true });
  publisher = pub;
  const preview = h('video', { class: 'live-video live-preview', autoplay: true, playsInline: true, muted: true });
  preview.setAttribute('playsinline', '');
  const badge = h('span', { class: 'live-badge live-off' }, 'OFFLINE');
  const meter = h('div', { class: 'level-meter' }, h('div', { class: 'level-fill' }));
  const cam = h('select', { class: 'input' });
  const mic = h('select', { class: 'input' });
  const spk = h('select', { class: 'input' });
  const rawCheck = h('input', { type: 'checkbox', checked: true });
  const fillDevices = (d: DeviceLists) => {
    for (const [sel, list, label] of [
      [cam, d.cameras, 'Cámara'],
      [mic, d.mics, 'Entrada de audio'],
      [spk, d.speakers, 'Salida'],
    ] as const) {
      const current = sel.value;
      clear(sel);
      sel.appendChild(h('option', { value: '' }, `${label} por defecto`));
      list.forEach((dev, i) => sel.appendChild(h('option', { value: dev.deviceId }, dev.label || `${label} ${i + 1}`)));
      sel.value = current;
    }
  };
  const info = {
    ws: h('span', null, '⚪ desconectado'),
    rtc: h('span', null, '⚪ sin transporte'),
    viewers: h('span', null, '0'),
    quality: h('span', null, '—'),
    metrics: h('span', { class: 'small muted' }, ''),
  };
  const claims = h('ul', { class: 'feed-list bingo-claims' });
  const startBtn = button('🔴 Iniciar transmisión', () => void start(), 'btn btn-primary btn-lg');
  const stopBtn = button('■ Detener transmisión', () => void stop(), 'btn btn-danger');
  const micBtn = button('🎙 Silenciar micrófono', () => void toggle('audio'), 'btn');
  const camBtn = button('📷 Apagar cámara', () => void toggle('video'), 'btn');
  stopBtn.disabled = true;

  const doPreview = async () => {
    try {
      const stream = await pub.preview({ cameraId: cam.value, micId: mic.value, rawAudio: rawCheck.checked });
      preview.srcObject = stream;
      fillDevices(await LiveHostPublisher.devices());
    } catch (err) {
      toast(`No se pudo abrir cámara/micrófono: ${errorMessage(err)}`, 'error');
    }
  };
  const start = async () => {
    startBtn.disabled = true;
    try {
      await pub.goLive();
      stopBtn.disabled = false;
      badge.textContent = '🔴 EN VIVO';
      badge.className = 'live-badge live-on';
      toast('Transmisión iniciada', 'success');
    } catch (err) {
      startBtn.disabled = false;
      toast(errorMessage(err), 'error');
    }
  };
  const stop = async () => {
    await pub.stop();
    preview.srcObject = null;
    stopBtn.disabled = true;
    startBtn.disabled = false;
    badge.textContent = 'OFFLINE';
    badge.className = 'live-badge live-off';
  };
  const toggle = async (kind: 'audio' | 'video') => {
    const muted = kind === 'audio' ? !pub.micMuted : !pub.camMuted;
    await pub.setMuted(kind, muted);
    if (kind === 'audio') micBtn.textContent = muted ? '🎙 Activar micrófono' : '🎙 Silenciar micrófono';
    else camBtn.textContent = muted ? '📷 Encender cámara' : '📷 Apagar cámara';
  };
  cam.addEventListener('change', () => void doPreview());
  mic.addEventListener('change', () => void doPreview());
  rawCheck.addEventListener('change', () => void doPreview());
  spk.addEventListener('change', () => {
    const v = preview as HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> };
    void v.setSinkId?.(spk.value).catch(() => undefined);
  });

  root.appendChild(
    h(
      'section',
      { class: 'panel live-host-panel' },
      h('div', { class: 'row space' }, h('h2', null, 'Vista previa'), badge),
      h('div', { class: 'live-frame' }, preview),
      h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Nivel de audio'), meter),
      h(
        'div',
        { class: 'fields' },
        h('label', { class: 'field' }, 'Cámara', cam),
        h('label', { class: 'field' }, 'Micrófono / mixer (entrada USB)', mic),
        h('label', { class: 'field' }, 'Monitor (altavoz de la vista previa)', spk),
        h('label', { class: 'field field-check' }, rawCheck, ' Audio sin procesar (recomendado con mixer: sin cancelación de eco ni AGC)'),
      ),
      h('div', { class: 'actions' }, button('Abrir cámara y micrófono', () => void doPreview(), 'btn'), startBtn, stopBtn, micBtn, camBtn),
    ),
  );
  root.appendChild(
    h(
      'section',
      { class: 'panel' },
      h('h2', null, 'Evento'),
      h('div', { class: 'info-grid' }, kv('Nombre', game?.playlistName ?? '—'), kv('Event ID', eventId), kv('Room ID', liveRoomId(eventId)), kv('Jugadores conectados', info.viewers), kv('Servidor WebRTC', info.rtc), kv('WebSocket', info.ws), kv('Calidad de envío', info.quality)),
      info.metrics,
      h('p', { class: 'small muted' }, 'Los jugadores entran desde el QR de la partida (Repartir con QR) y ven esta transmisión encima de su cartón.'),
    ),
  );
  root.appendChild(h('section', { class: 'panel' }, h('h2', null, 'Bingos cantados'), h('p', { class: 'small muted' }, 'El servidor comprueba cada bingo con la tarjeta y las canciones cantadas. Anuncia al ganador para que lo vean todos.'), claims));

  timers.push(
    setInterval(() => {
      (meter.firstElementChild as HTMLElement).style.width = `${Math.round(pub.level() * 100)}%`;
    }, 100),
    setInterval(() => {
      void pub.stats().then((s) => {
        if (!s) return;
        info.rtc.textContent = pub.live ? '🟢 publicando' : '⚪ sin transporte';
        info.quality.textContent = `${s.videoKbps + s.audioKbps} kb/s (vídeo ${s.videoKbps} · audio ${s.audioKbps})${s.width ? ` · ${s.width}×${s.height}` : ''}${s.fps ? ` · ${Math.round(s.fps)} fps` : ''}${s.rttMs !== undefined ? ` · RTT ${Math.round(s.rttMs)} ms` : ''}`;
      });
    }, 2000),
  );

  const setWs = (state: LinkState) => {
    info.ws.textContent = state === 'LIVE' ? '🟢 conectado' : state === 'RECONNECTING' ? '🟡 reconectando…' : '🔴 desconectado';
  };
  void session
    .connect()
    .then((ack) => {
      if (ack.role !== 'host') {
        toast('El token no es de animador: revisa LIVE_HOST_TOKEN.', 'error');
        return;
      }
      setWs(session.state);
      info.viewers.textContent = String(ack.viewers);
      offs.push(
        session.onState(setWs),
        session.on(LIVE_EVENTS.playersCount, (p: { viewers: number }) => {
          info.viewers.textContent = String(p.viewers);
        }),
        session.on(LIVE_EVENTS.stats, (m: LiveMetrics) => {
          info.viewers.textContent = String(m.viewers);
          info.metrics.textContent = `Pico ${m.viewersPeak} · entradas ${m.joins} · desconexiones ${m.disconnects} · reconexiones ${m.reconnections} · media conectado ${Math.round(m.avgConnectedMs / 1000)} s · bingos ${m.bingos} · reacciones ${m.reactions} · errores WebRTC ${m.webrtcErrors}`;
        }),
        session.on(LIVE_EVENTS.bingoClaimed, (c: BingoClaimed) => {
          const verdict = c.valid === null ? '⚪ sin comprobar' : c.valid ? '🟢 válido' : `🔴 no válido (${c.serverStatus ?? 'none'})`;
          const li = h('li', { class: c.valid ? 'ok' : '' }, h('strong', null, c.name || 'Jugador'), ` · ${cardLabel(c.seed, c.index)} · ${c.kind === 'line' ? 'línea' : 'bingo'} · ${verdict} `);
          li.appendChild(
            button('🎉 Anunciar ganador', () => {
              void session.request(LIVE_EVENTS.winner, { seed: c.seed, index: c.index, name: c.name, kind: c.kind }).then(() => {
                li.appendChild(h('span', { class: 'badge badge-ok' }, 'anunciado'));
              });
            }, 'btn btn-sm btn-primary'),
          );
          claims.prepend(li);
          navigator.vibrate?.([200]);
          toast(`${c.name || 'Un jugador'} canta ${c.kind === 'line' ? 'línea' : 'bingo'} (${verdict})`, c.valid ? 'success' : 'info');
        }),
      );
    })
    .catch((err) => toast(errorMessage(err), 'error'));
  void doPreview();
}

function kv(label: string, value: string | HTMLElement): HTMLElement {
  return h('div', { class: 'kv' }, h('span', { class: 'small muted' }, label), h('strong', null, value));
}
