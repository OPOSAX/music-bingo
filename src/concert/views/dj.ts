/** Panel del DJ del karaoke. Lista READY, slots MIC A/B, motor de audio y panel técnico. */

import { navigate } from '../../router.js';
import { button, clear, errorMessage, formatDuration, h, toast } from '../../dom.js';
import { encodeText, toSvgElement } from '../../qr.js';
import { currentTrackIndex, loadGame } from '../../store.js';
import { ConcertAudioEngine, TECHNICAL_MODES, type ChannelMetrics, type RecordingTap, type TechnicalMode } from '../audio/audio-engine.js';
import { BrowserOutputProvider } from '../audio/output-provider.js';
import { InternalPlayerReferenceProvider, MixerInputReferenceProvider, NullReferenceProvider, SpotifyReferenceProvider, type ReferenceAudioProvider } from '../audio/reference-provider.js';
import type { ConsumerAdapter } from '../consumer.js';
import { DjClient } from '../dj-client.js';
import { ConcertMediaService, LocalMediaAdapter } from '../media-service.js';
import { ParticipantClient } from '../participant-client.js';
import type { AudioProfile, ConcertConfig, NoiseReduction, ParticipantInfo, ReferenceAudioMode, SlotInfo, SlotState } from '../protocol.js';
import { createConsumerAdapter, createSignaling, demoHub, detectConcertServer, endpointFromParams, isDemo, participantJoinUrl, type ConcertEndpoint } from '../session.js';
import { loadConfig, loadDevicePrefs, loadToken, saveConfig, saveDevicePrefs, saveToken } from '../store.js';

interface DjSession {
  dj: DjClient;
  engine: ConcertAudioEngine;
  consumer: ConsumerAdapter;
  endpoint: ConcertEndpoint;
  config: ConcertConfig;
  consumed: Map<string, string>; // producerId → slotId
  demoPhones: ParticipantClient[];
  timers: ReturnType<typeof setInterval>[];
  unsubscribe: (() => void)[];
}

let session: DjSession | null = null;
let listQuery = '';
let listOffset = 0;
const PAGE = 50;
let selectedSlot: string | null = null;

export async function releaseDj(): Promise<void> {
  const s = session;
  session = null;
  if (!s) return;
  s.timers.forEach(clearInterval);
  s.unsubscribe.forEach((u) => u());
  for (const p of s.demoPhones) await p.disconnect().catch(() => undefined);
  s.consumer.closeAll();
  s.dj.disconnect();
  await s.engine.stop().catch(() => undefined);
}

export async function renderDj(root: HTMLElement, params: URLSearchParams): Promise<void> {
  clear(root);
  root.appendChild(h('section', { class: 'page-header' }, h('div', null, h('h1', null, '🎤 Karaoke · panel del DJ'), h('p', { class: 'lead' }, 'Micrófonos del público, controlados desde aquí.')), h('div', { class: 'actions' }, button('Panel de la partida', () => navigate('/host'), 'btn'), button('Mis eventos', () => navigate('/events'), 'btn btn-link'))));
  if (!session) {
    root.appendChild(renderConfigForm(root, params));
    return;
  }
  const s = session;
  const dynamic = h('div', { class: 'dj-dynamic' });
  root.appendChild(renderJoinPanel(s));
  root.appendChild(dynamic);
  root.appendChild(renderAudioPanel(s));
  root.appendChild(
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'actions' }, button('Cerrar panel', () => void releaseDj().then(() => renderDj(root, params)), 'btn btn-danger'), h('span', { class: 'small muted' }, `Sala ${s.endpoint.roomId} · ${isDemo(s.endpoint) ? 'demo local' : s.endpoint.btalkUrl}`)),
    ),
  );
  let scheduled = false;
  const refresh = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (session !== s) return;
      drawDynamic(dynamic, s);
      void syncConsumers(s);
    });
  };
  s.unsubscribe.push(s.dj.onChange(refresh));
  s.timers.push(setInterval(refresh, 1000));
  drawDynamic(dynamic, s);
}

/* ---------------- Configuración y conexión ---------------- */

function renderConfigForm(root: HTMLElement, params: URLSearchParams): HTMLElement {
  const config = loadConfig();
  const endpoint = endpointFromParams(params, config);
  const btalk = h('input', { class: 'input', type: 'url', placeholder: 'https://servidor-concert (vacío = demo local)', value: endpoint.btalkUrl });
  const token = h('input', { class: 'input', type: 'password', placeholder: 'CONCERT_DJ_TOKEN del servidor', value: endpoint.token ?? loadToken(), autocomplete: 'off' });
  const room = h('input', { class: 'input', type: 'text', value: endpoint.roomId, placeholder: 'ID de sala' });
  if (!btalk.value) {
    void detectConcertServer().then((url) => {
      if (url && !btalk.value) {
        btalk.value = url;
        toast('Servidor Concert detectado en este mismo origen', 'info');
      }
    });
  }
  const maxLive = h('input', { class: 'input', type: 'number', min: '1', max: '8', value: String(config.maxLiveMics) });
  const maxPrepared = h('input', { class: 'input', type: 'number', min: '1', max: '8', value: String(config.maxPreparedMics) });
  const profile = select<AudioProfile>(['SING', 'TALK'], config.audioProfile, { SING: 'SING (cantar)', TALK: 'TALK (hablar)' });
  const ns = select<NoiseReduction>(['OFF', 'LIGHT', 'MEDIUM', 'STRONG'], config.noiseReduction, { OFF: 'Sin reducción', LIGHT: 'Ligera', MEDIUM: 'Media', STRONG: 'Fuerte' });
  const reference = select<ReferenceAudioMode>(['MIXER', 'INTERNAL', 'SPOTIFY', 'NONE'], config.referenceAudioMode, { MIXER: 'Entrada USB del mixer (recomendado)', INTERNAL: 'Reproductor interno', SPOTIFY: 'Spotify (solo metadata)', NONE: 'Sin referencia' });
  const aec = h('input', { type: 'checkbox', checked: config.aecEnabled });
  const form = h(
    'form',
    { class: 'panel' },
    h('h2', null, 'Configuración'),
    h('p', { class: 'small muted' }, 'Las mismas variables que el servidor (CONCERT_MODE, MAX_LIVE_MICS…). Sin URL de B-Talk el panel funciona en modo demo dentro de esta pestaña.'),
    h(
      'div',
      { class: 'fields' },
      h('label', { class: 'field' }, 'BTALK_URL (servidor Concert)', btalk),
      h('label', { class: 'field' }, 'Token del DJ', token),
      h('label', { class: 'field' }, 'Sala', room),
      h('label', { class: 'field' }, 'MAX_LIVE_MICS', maxLive),
      h('label', { class: 'field' }, 'MAX_PREPARED_MICS', maxPrepared),
      h('label', { class: 'field' }, 'CONCERT_AUDIO_PROFILE', profile),
      h('label', { class: 'field' }, 'CONCERT_NOISE_REDUCTION', ns),
      h('label', { class: 'field' }, 'REFERENCE_AUDIO_MODE', reference),
      h('label', { class: 'field field-check' }, aec, ' AEC_ENABLED (cancelador por referencia)'),
    ),
    h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Abrir panel del DJ'),
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const next: ConcertConfig = {
      ...config,
      concertMode: true,
      btalkUrl: btalk.value.trim().replace(/\/$/, ''),
      maxLiveMics: Math.max(1, Number(maxLive.value) || 2),
      maxPreparedMics: Math.max(1, Number(maxPrepared.value) || 2),
      audioProfile: profile.value as AudioProfile,
      noiseReduction: ns.value as NoiseReduction,
      referenceAudioMode: reference.value as ReferenceAudioMode,
      aecEnabled: aec.checked,
    };
    saveConfig(next);
    const ep: ConcertEndpoint = { btalkUrl: next.btalkUrl, roomId: room.value.trim() || 'demo' };
    saveToken(token.value);
    if (token.value.trim()) ep.token = token.value.trim();
    const submit = form.querySelector('button[type=submit]') as HTMLButtonElement;
    submit.disabled = true;
    try {
      await connect(ep, next);
      await renderDj(root, params);
    } catch (err) {
      toast(errorMessage(err), 'error');
      submit.disabled = false;
    }
  });
  return form;
}

function select<T extends string>(values: readonly T[], current: T, labels: Record<T, string>): HTMLSelectElement {
  const el = h('select', { class: 'input' });
  for (const v of values) el.appendChild(h('option', { value: v, selected: v === current }, labels[v]));
  return el;
}

async function connect(endpoint: ConcertEndpoint, config: ConcertConfig): Promise<void> {
  const signaling = await createSignaling(endpoint, 'dj', config);
  const dj = new DjClient(signaling, endpoint.roomId);
  const engine = new ConcertAudioEngine({ workletUrl: 'js/concert/audio/worklet.js', profile: config.audioProfile, noiseReduction: config.noiseReduction, aecEnabled: config.aecEnabled });
  const consumer = await createConsumerAdapter(endpoint, signaling, () => engine.ctx);
  await dj.connect('DJ');
  listQuery = '';
  listOffset = 0;
  selectedSlot = null;
  session = { dj, engine, consumer, endpoint, config, consumed: new Map(), demoPhones: [], timers: [], unsubscribe: [] };
  if (isDemo(endpoint)) {
    const hub = demoHub(config, endpoint.roomId);
    session.timers.push(setInterval(() => hub.room.setNowPlaying(nowPlaying()), 5000));
    hub.room.setNowPlaying(nowPlaying());
  }
}

function nowPlaying() {
  const game = loadGame();
  const idx = game ? currentTrackIndex(game) : null;
  const track = idx !== null && game ? game.tracks[idx] : undefined;
  if (!track) return null;
  const playing = game?.lastPlay ? Date.now() - game.lastPlay.at < game.lastPlay.len : false;
  return { title: track.name, artist: track.artists, uri: track.uri, playing, t: Date.now() };
}

/* ---------------- Enlace / QR ---------------- */

function renderJoinPanel(s: DjSession): HTMLElement {
  const url = participantJoinUrl(s.endpoint);
  const details = h('details', { class: 'panel' }, h('summary', null, '📱 Enlace para el público'));
  details.appendChild(h('p', { class: 'small muted' }, 'El público escanea este QR o abre el enlace y pulsa ESTOY DISPONIBLE.'));
  details.appendChild(h('div', { class: 'deal-qr concert-qr' }, toSvgElement(encodeText(url, { ecc: 'M' }), { border: 2, className: 'qr' })));
  details.appendChild(h('p', { class: 'small' }, h('a', { class: 'deal-link', href: url, target: '_blank' }, url)));
  if (isDemo(s.endpoint)) {
    details.appendChild(
      h('div', { class: 'actions' }, button('Simular 5 teléfonos', () => void simulatePhones(s, 5), 'btn btn-sm'), button('Simular 100 teléfonos', () => void simulatePhones(s, 100), 'btn btn-sm'), h('span', { class: 'small muted' }, 'Los teléfonos simulados aceptan PREPARE automáticamente.')),
    );
  }
  return details;
}

/** Teléfonos simulados en la misma pestaña (solo demo): obedecen al hub local con un micrófono ficticio. */
async function simulatePhones(s: DjSession, count: number): Promise<void> {
  const hub = demoHub(s.config, s.endpoint.roomId);
  const names = ['Ana', 'Beto', 'Carla', 'Dani', 'Eva', 'Fran', 'Gaby', 'Hugo', 'Iris', 'Javi'];
  const base = s.demoPhones.length;
  for (let i = 0; i < count; i++) {
    const n = base + i;
    const fakeTrack = { kind: 'audio', stop: () => undefined } as unknown as MediaStreamTrack;
    const media = new ConcertMediaService(new LocalMediaAdapter((p) => void hub.registerProducer(p)), async () => ({ getAudioTracks: () => [fakeTrack], getTracks: () => [fakeTrack] }) as unknown as MediaStream);
    const meta: { mesa: string; device: string } = { mesa: `Mesa ${1 + (n % 12)}`, device: 'sim' };
    const client = new ParticipantClient(hub.client('participant'), media, { participantId: `sim-${n}`, roomId: s.endpoint.roomId, name: `${names[n % names.length]} ${Math.floor(n / names.length) + 1}`, meta });
    await client.connect();
    await client.ready();
    s.demoPhones.push(client);
  }
  toast(`${count} teléfonos simulados en READY`, 'success');
}

/* ---------------- Zona dinámica: contadores, slots, lista, registro ---------------- */

function drawDynamic(host: HTMLElement, s: DjSession): void {
  clear(host);
  const m = s.dj.metrics;
  const np = m?.nowPlaying;
  host.appendChild(
    h(
      'section',
      { class: 'panel dj-summary' },
      h('div', { class: 'now-playing' }, h('span', { class: 'muted small' }, 'Sonando: '), np ? h('strong', null, `${np.title} · ${np.artist}`) : h('span', { class: 'muted' }, 'sin información')),
      h(
        'div',
        { class: 'row dj-counts' },
        stat('Conectados', m?.connected ?? 0),
        stat('Disponibles', m?.ready ?? 0, 'stat-ready'),
        stat('Preparados', (m?.preparing ?? 0) + (m?.prepared ?? 0), 'stat-prep'),
        stat('En vivo', m?.live ?? 0, 'stat-live'),
        stat('Silenciados', m?.muted ?? 0),
      ),
    ),
  );
  const slots = h('section', { class: 'panel' }, h('h2', null, 'Micrófonos'));
  const grid = h('div', { class: 'slot-grid' });
  for (const slot of s.dj.slots) grid.appendChild(renderSlot(s, slot));
  slots.appendChild(grid);
  host.appendChild(slots);
  host.appendChild(renderReadyList(s));
  host.appendChild(renderLog(s));
}

function stat(label: string, value: number, cls = ''): HTMLElement {
  return h('div', { class: `stat ${cls}` }, h('strong', null, String(value)), ' ', h('span', { class: 'small muted' }, label));
}

const SLOT_BADGE: Record<SlotState, string> = { EMPTY: 'badge', PREPARING: 'badge badge-warn', PREPARED: 'badge badge-warn', LIVE: 'badge badge-live', MUTED: 'badge badge-muted' };
const SLOT_LABEL: Record<SlotState, string> = { EMPTY: 'Libre', PREPARING: 'Preparando…', PREPARED: 'Preparado', LIVE: 'EN VIVO', MUTED: 'Silenciado' };

function renderSlot(s: DjSession, slot: SlotInfo): HTMLElement {
  const p = s.dj.participant(slot.participantId);
  const card = h('div', { class: `slot slot-${slot.state.toLowerCase()} ${selectedSlot === slot.slotId ? 'slot-selected' : ''}` });
  card.appendChild(h('div', { class: 'row space' }, h('h3', null, slot.slotId.replace('MIC_', 'MIC ')), h('span', { class: SLOT_BADGE[slot.state] }, SLOT_LABEL[slot.state])));
  if (p) {
    card.appendChild(h('p', { class: 'slot-name' }, p.name, p.mesa ? h('span', { class: 'muted small' }, ` · ${p.mesa}`) : null));
    card.appendChild(h('p', { class: 'small muted' }, qualityBadge(p), slot.since ? ` · ${formatDuration(Date.now() - slot.since)}` : ''));
  } else {
    card.appendChild(h('p', { class: 'small muted' }, selectedSlot === slot.slotId ? 'Elige a alguien de la lista ↓' : 'Vacío'));
  }
  const metrics = s.engine.channels.get(slot.slotId)?.metrics();
  if (metrics) card.appendChild(renderMetrics(s, metrics));
  const actions = h('div', { class: 'actions' });
  const pid = slot.participantId;
  const act = (label: string, fn: () => Promise<void>, cls = 'btn btn-sm') => actions.appendChild(button(label, () => void fn().catch((err) => toast(errorMessage(err), 'error')), cls));
  switch (slot.state) {
    case 'EMPTY':
      actions.appendChild(
        button(
          selectedSlot === slot.slotId ? 'Cancelar selección' : 'PREPARE…',
          () => {
            selectedSlot = selectedSlot === slot.slotId ? null : slot.slotId;
            s.dj.onChange(() => undefined);
            refreshNow(s);
          },
          'btn btn-sm btn-primary',
        ),
      );
      break;
    case 'PREPARING':
      if (pid) act('CANCEL', () => s.dj.end(pid), 'btn btn-sm btn-danger');
      break;
    case 'PREPARED':
      if (pid) act('▶ GO LIVE', () => s.dj.goLive(pid), 'btn btn-sm btn-primary');
      if (pid) act('CANCEL', () => s.dj.end(pid), 'btn btn-sm');
      break;
    case 'LIVE':
      if (pid) act('🔇 MUTE', () => s.dj.mute(pid));
      if (pid) act('■ END', () => s.dj.end(pid), 'btn btn-sm btn-danger');
      break;
    case 'MUTED':
      if (pid) act('🔊 UNMUTE', () => s.dj.unmute(pid), 'btn btn-sm btn-primary');
      if (pid) act('■ END', () => s.dj.end(pid), 'btn btn-sm btn-danger');
      break;
  }
  card.appendChild(actions);
  return card;
}

function refreshNow(s: DjSession): void {
  const host = document.querySelector('.dj-dynamic');
  if (host instanceof HTMLElement) drawDynamic(host, s);
}

function qualityBadge(p: ParticipantInfo): HTMLElement {
  const q = p.quality ?? 'UNKNOWN';
  const icon = q === 'GOOD' ? '🟢' : q === 'FAIR' ? '🟡' : q === 'BAD' ? '🔴' : '⚪';
  return h('span', { class: 'quality', title: `Conexión ${q}` }, `${icon} ${q === 'UNKNOWN' ? 'sin datos' : q.toLowerCase()}`);
}

function renderMetrics(s: DjSession, m: ChannelMetrics): HTMLElement {
  const quality = ConcertAudioEngine.aecQuality(m, s.engine.referenceHasAudio);
  return h(
    'div',
    { class: 'slot-metrics small muted' },
    h('span', null, `Nivel ${m.inputDb.toFixed(0)} → ${m.outputDb.toFixed(0)} dBFS`),
    s.engine.referenceHasAudio ? h('span', null, ` · retardo ref ${m.referenceDelayMs.toFixed(0)} ms · ERLE ${m.erleDb.toFixed(1)} dB · corr ${m.referenceCorrelation.toFixed(2)}`) : null,
    m.doubleTalk ? h('span', { class: 'badge badge-warn' }, 'voz+música') : null,
    h('span', { class: `aec-${quality.toLowerCase()}` }, ` AEC ${quality}`),
  );
}

function renderReadyList(s: DjSession): HTMLElement {
  let page = s.dj.readyPage(listQuery, listOffset, PAGE);
  if (listOffset >= page.total && page.total > 0) {
    listOffset = Math.max(0, Math.floor((page.total - 1) / PAGE) * PAGE);
    page = s.dj.readyPage(listQuery, listOffset, PAGE);
  }
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Buscar por nombre, mesa o sector', value: listQuery });
  search.addEventListener('input', () => {
    listQuery = search.value;
    listOffset = 0;
    refreshNow(s);
    const again = document.querySelector('.ready-search') as HTMLInputElement | null;
    again?.focus();
    again?.setSelectionRange(again.value.length, again.value.length);
  });
  search.classList.add('ready-search');
  const panel = h('section', { class: 'panel' }, h('div', { class: 'row space' }, h('h2', null, `Disponibles (${page.total})`), selectedSlot ? h('span', { class: 'badge badge-warn' }, `Eligiendo para ${selectedSlot.replace('MIC_', 'MIC ')}`) : null), h('div', { class: 'row' }, search));
  const list = h('ul', { class: 'ready-list' });
  const freeSlots = s.dj.slots.filter((sl) => sl.state === 'EMPTY').map((sl) => sl.slotId);
  for (const p of page.items) {
    const li = h('li', { class: 'ready-row' });
    li.appendChild(h('div', { class: 'ready-info' }, h('strong', null, p.name), h('span', { class: 'small muted' }, [p.mesa, p.sector, p.asiento].filter(Boolean).join(' · ') || (p.device ?? '')), h('span', { class: 'small muted' }, ` · espera ${p.timestampReady ? formatDuration(Date.now() - p.timestampReady) : '—'} · `, qualityBadge(p))));
    const actions = h('div', { class: 'actions' });
    const targets = selectedSlot ? [selectedSlot] : freeSlots;
    for (const slotId of targets) {
      actions.appendChild(
        button(
          `PREPARE → ${slotId.replace('MIC_', '')}`,
          () => {
            selectedSlot = null;
            void s.dj.prepare(p.participantId, slotId).catch((err) => toast(errorMessage(err), 'error'));
          },
          'btn btn-sm btn-primary',
        ),
      );
    }
    if (targets.length === 0) actions.appendChild(h('span', { class: 'small muted' }, 'sin slot libre'));
    li.appendChild(actions);
    list.appendChild(li);
  }
  if (page.items.length === 0) list.appendChild(h('li', { class: 'muted small' }, page.total === 0 ? 'Nadie disponible todavía.' : 'Sin resultados en esta página.'));
  panel.appendChild(list);
  if (page.total > PAGE) {
    panel.appendChild(
      h(
        'div',
        { class: 'actions' },
        button('◀ Anteriores', () => { listOffset = Math.max(0, listOffset - PAGE); refreshNow(s); }, 'btn btn-sm'),
        h('span', { class: 'small muted' }, `${listOffset + 1}–${Math.min(listOffset + PAGE, page.total)} de ${page.total}`),
        button('Siguientes ▶', () => { listOffset = Math.min(listOffset + PAGE, Math.floor((page.total - 1) / PAGE) * PAGE); refreshNow(s); }, 'btn btn-sm'),
      ),
    );
  }
  return panel;
}

function renderLog(s: DjSession): HTMLElement {
  const details = h('details', { class: 'panel', open: s.dj.log.some((e) => e.kind === 'error' && Date.now() - e.t < 15_000) }, h('summary', null, `Registro (${s.dj.log.length})`));
  const list = h('ul', { class: 'feed-list' });
  for (const e of s.dj.log.slice(0, 20)) list.appendChild(h('li', { class: e.kind === 'error' ? 'alert-error' : '' }, h('span', { class: 'muted small' }, new Date(e.t).toLocaleTimeString()), ' ', e.text));
  details.appendChild(list);
  return details;
}

/* ---------------- Consumo de los micrófonos hacia el motor ---------------- */

async function syncConsumers(s: DjSession): Promise<void> {
  const active = new Map<string, string>();
  for (const slot of s.dj.slots) if (slot.producerId && (slot.state === 'PREPARED' || slot.state === 'LIVE' || slot.state === 'MUTED')) active.set(slot.producerId, slot.slotId);
  for (const [producerId, slotId] of [...s.consumed]) {
    if (!active.has(producerId)) {
      s.consumer.close(producerId);
      s.engine.removeMic(slotId);
      s.consumed.delete(producerId);
    }
  }
  if (!s.engine.running) return;
  for (const [producerId, slotId] of active) {
    if (s.consumed.has(producerId)) continue;
    s.consumed.set(producerId, slotId);
    try {
      const source = await s.consumer.consume(producerId);
      if (session !== s || !s.consumed.has(producerId)) return;
      s.engine.addMic(slotId, source);
    } catch (err) {
      s.consumed.delete(producerId);
      toast(`No se pudo recibir ${slotId}: ${errorMessage(err)}`, 'error');
    }
  }
}

/* ---------------- Motor de audio y panel técnico ---------------- */

function renderAudioPanel(s: DjSession): HTMLElement {
  const prefs = loadDevicePrefs();
  const panel = h('section', { class: 'panel audio-panel' }, h('h2', null, '🎚 Motor de audio'));
  const status = h('p', { class: 'small muted' }, s.engine.running ? 'Motor en marcha.' : 'Detenido. Inícialo para escuchar los micrófonos por la salida elegida (interfaz USB → mixer).');
  const inputSel = h('select', { class: 'input' }, h('option', { value: '' }, 'Entrada por defecto'));
  const channelSel = select(['0', '1'], String(prefs.referenceChannel ?? 0), { '0': 'Canal L (1)', '1': 'Canal R (2)' });
  const outputSel = h('select', { class: 'input' }, h('option', { value: '' }, 'Salida por defecto'));
  const refMode = select<ReferenceAudioMode>(['MIXER', 'INTERNAL', 'SPOTIFY', 'NONE'], s.config.referenceAudioMode, { MIXER: 'Entrada USB del mixer', INTERNAL: 'Reproductor interno (archivo)', SPOTIFY: 'Spotify (solo metadata)', NONE: 'Sin referencia' });
  const file = h('input', { class: 'input', type: 'file', accept: 'audio/*' });
  const audioEl = h('audio', { controls: true, loop: true });
  audioEl.style.width = '100%';
  const fillDevices = async () => {
    try {
      const [ins, outs] = await Promise.all([MixerInputReferenceProvider.listInputs(), BrowserOutputProvider.listOutputs()]);
      for (const d of ins) inputSel.appendChild(h('option', { value: d.deviceId, selected: d.deviceId === prefs.referenceInputId }, d.label || `Entrada ${d.deviceId.slice(0, 6)}`));
      for (const d of outs) outputSel.appendChild(h('option', { value: d.deviceId, selected: d.deviceId === prefs.outputId }, d.label || `Salida ${d.deviceId.slice(0, 6)}`));
    } catch {
      /* sin permisos todavía */
    }
  };
  void fillDevices();

  const buildReference = (): ReferenceAudioProvider => {
    const mode = refMode.value as ReferenceAudioMode;
    saveDevicePrefs({ referenceInputId: inputSel.value, referenceChannel: Number(channelSel.value), outputId: outputSel.value });
    switch (mode) {
      case 'MIXER':
        return new MixerInputReferenceProvider(inputSel.value, undefined, Number(channelSel.value));
      case 'INTERNAL':
        return new InternalPlayerReferenceProvider(audioEl);
      case 'SPOTIFY':
        return new SpotifyReferenceProvider(() => {
          const np = nowPlaying();
          return np ? { title: np.title, artist: np.artist, uri: np.uri, playing: np.playing, t: np.t } : null;
        });
      default:
        return new NullReferenceProvider();
    }
  };
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (f) audioEl.src = URL.createObjectURL(f);
  });

  const startBtn = button(
    '▶ Iniciar motor',
    async () => {
      try {
        await s.engine.setReference(buildReference());
        await s.engine.setOutput(new BrowserOutputProvider(outputSel.value));
        await s.engine.start();
        status.textContent = `Motor en marcha · referencia: ${s.engine.referenceLabel} · ${s.engine.ctx?.sampleRate ?? 0} Hz`;
        toast('Motor de audio iniciado', 'success');
        void syncConsumers(s);
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    },
    'btn btn-primary',
  );
  const applyBtn = button('Aplicar dispositivos', async () => {
    try {
      await s.engine.setReference(buildReference());
      await s.engine.setOutput(new BrowserOutputProvider(outputSel.value));
      status.textContent = `Motor en marcha · referencia: ${s.engine.referenceLabel}`;
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });
  const stopBtn = button('■ Detener', async () => {
    s.consumer.closeAll();
    s.consumed.clear();
    await s.engine.stop();
    status.textContent = 'Detenido.';
  });

  panel.appendChild(status);
  panel.appendChild(
    h(
      'div',
      { class: 'fields' },
      h('label', { class: 'field' }, 'Referencia (MUSIC_REFERENCE)', refMode),
      h('label', { class: 'field' }, 'Entrada USB (AUX/MATRIX del mixer)', inputSel),
      h('label', { class: 'field' }, 'Canal de la referencia', channelSel),
      h('label', { class: 'field' }, 'Salida (hacia el mixer)', outputSel),
      h('label', { class: 'field' }, 'Archivo para el reproductor interno', file, audioEl),
    ),
  );
  panel.appendChild(h('div', { class: 'actions' }, startBtn, applyBtn, stopBtn));
  panel.appendChild(renderTechnical(s));
  return panel;
}

function renderTechnical(s: DjSession): HTMLElement {
  const details = h('details', { class: 'technical' }, h('summary', null, '🔬 Panel técnico (A/B, DSP y grabación)'));
  const mode = select<TechnicalMode>(TECHNICAL_MODES, s.engine.mode, { RAW: 'RAW (sin procesar)', AEC_ONLY: 'AEC ONLY', AEC_NS: 'AEC + NS', FINAL: 'FINAL (cadena completa)' });
  mode.addEventListener('change', () => s.engine.setMode(mode.value as TechnicalMode));
  const profile = select<AudioProfile>(['SING', 'TALK'], s.engine.profile, { SING: 'SING', TALK: 'TALK' });
  profile.addEventListener('change', () => s.engine.setProfile(profile.value as AudioProfile));
  const ns = select<NoiseReduction>(['OFF', 'LIGHT', 'MEDIUM', 'STRONG'], s.engine.noiseReduction, { OFF: 'OFF', LIGHT: 'LIGHT', MEDIUM: 'MEDIUM', STRONG: 'STRONG' });
  ns.addEventListener('change', () => s.engine.setNoiseReduction(ns.value as NoiseReduction));
  const aec = h('input', { type: 'checkbox', checked: s.engine.aecEnabled });
  aec.addEventListener('change', () => s.engine.setAec(aec.checked));
  const autoDelay = h('input', { type: 'checkbox', checked: s.engine.referenceDelayMs === null });
  const delay = h('input', { class: 'input', type: 'number', min: '0', max: '1000', step: '1', value: String(s.engine.referenceDelayMs ?? 0), disabled: autoDelay.checked });
  const applyDelay = () => {
    delay.disabled = autoDelay.checked;
    s.engine.setReferenceDelay(autoDelay.checked ? null : Math.max(0, Math.min(1000, Number(delay.value) || 0)));
  };
  autoDelay.addEventListener('change', applyDelay);
  delay.addEventListener('change', applyDelay);
  const master = h('input', { class: 'volume', type: 'range', min: '-24', max: '12', step: '1', value: '0' });
  master.addEventListener('input', () => s.engine.setMasterGainDb(Number(master.value)));
  const metrics = h('pre', { class: 'metrics small' }, 'Sin micrófonos activos.');
  s.timers.push(
    setInterval(() => {
      const list = s.engine.metrics();
      metrics.textContent = list.length
        ? list
            .map((m) => `${m.slotId}: in ${m.inputDb.toFixed(1)} dBFS · out ${m.outputDb.toFixed(1)} dBFS · reducción ${m.aecReductionDb.toFixed(1)} dB · retardo ${m.referenceDelayMs.toFixed(0)} ms · corr ${m.referenceCorrelation.toFixed(2)} · ERLE ${m.erleDb.toFixed(1)} dB${m.doubleTalk ? ' · doble voz' : ''}`)
            .join('\n')
        : s.engine.running
          ? 'Motor en marcha, sin micrófonos activos.'
          : 'Motor detenido.';
    }, 500),
  );
  const slotSel = h('select', { class: 'input' });
  for (const id of s.dj.slots.map((sl) => sl.slotId)) slotSel.appendChild(h('option', { value: id }, id));
  const links = h('div', { class: 'row rec-links' });
  const recBtn = button('⏺ Grabar 4 pistas', () => {
    try {
      s.engine.startRecording(slotSel.value);
      recBtn.disabled = true;
      stopRec.disabled = false;
      toast('Grabando rawMic, musicReference, postAEC y finalOutput…', 'info');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });
  const stopRec = button('⏹ Parar y descargar', async () => {
    const blobs = await s.engine.stopRecording();
    recBtn.disabled = false;
    stopRec.disabled = true;
    clear(links);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const [tap, blob] of Object.entries(blobs) as [RecordingTap, Blob][]) {
      const a = h('a', { class: 'btn btn-sm', href: URL.createObjectURL(blob), download: `${stamp}-${slotSel.value}-${tap}.webm` }, `⬇ ${tap}`);
      links.appendChild(a);
    }
  });
  stopRec.disabled = true;
  details.appendChild(
    h(
      'div',
      { class: 'fields' },
      h('label', { class: 'field' }, 'Modo A/B', mode),
      h('label', { class: 'field' }, 'Perfil', profile),
      h('label', { class: 'field' }, 'Reducción de ruido', ns),
      h('label', { class: 'field field-check' }, aec, ' AEC por referencia'),
      h('label', { class: 'field field-check' }, autoDelay, ' Retardo de referencia automático'),
      h('label', { class: 'field' }, 'Retardo manual (ms, 0–1000)', delay),
      h('label', { class: 'field' }, 'Ganancia master (dB)', master),
    ),
  );
  details.appendChild(metrics);
  details.appendChild(h('div', { class: 'row' }, h('label', { class: 'field' }, 'Slot a grabar', slotSel), recBtn, stopRec));
  details.appendChild(links);
  return details;
}
