/**
 * Panel del anfitrión "Quieren cantar": los jugadores pulsan "Quiero cantar" en su tarjeta (misma sala que la partida)
 * y aparecen aquí. Con un solo botón el anfitrión autoriza: el servidor prepara el micrófono del teléfono, al estar
 * listo lo pone en vivo y el audio suena por este equipo, procesado (paso alto, EQ, compresor, limitador y ganancia)
 * para que la voz se oiga por encima de la música; la música baja sola mientras alguien canta. Silenciar y Terminar
 * siempre a mano. El panel del DJ sigue disponible para el control avanzado (cancelación de eco, varios micrófonos).
 */

import { button, clear, errorMessage, formatDuration, h, toast } from '../../dom.js';
import { navigate } from '../../router.js';
import type { ConsumerAdapter } from '../consumer.js';
import { DjClient } from '../dj-client.js';
import { EVENTS, type ParticipantInfo, type ParticipantState } from '../protocol.js';
import { createConsumerAdapter, createSignaling, type ConcertEndpoint } from '../session.js';
import { loadConfig } from '../store.js';
import { DEFAULT_MIX, VoiceChain, loadMix, saveMix, type MixSettings } from '../audio/voice-chain.js';

/** Control del volumen de la música (reproductor de Spotify del anfitrión) para bajarla mientras alguien canta. */
export interface MusicControl {
  /** Volumen actual 0..1 */
  get(): number;
  set(volume: number): Promise<void> | void;
}

export interface KaraokeHostOptions {
  music?: MusicControl;
}

interface Watcher {
  dj: DjClient;
  room: string;
  offs: (() => void)[];
  /** Autorizados por el anfitrión: al quedar PREPARED pasan a LIVE automáticamente. */
  autoLive: Set<string>;
  consumer: ConsumerAdapter | null;
  ctx: AudioContext | null;
  master: GainNode | null;
  playing: Map<string, { stop(): void; chain?: VoiceChain }>; // producerId → salida de audio
  mix: MixSettings;
  music: MusicControl | null;
  /** Volumen de la música antes de bajarla (null = no está bajada). */
  musicBefore: number | null;
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
  void restoreMusic(w);
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

export function renderKaraokeHostPanel(endpoint: ConcertEndpoint, options: KaraokeHostOptions = {}): HTMLElement {
  const list = h('ul', { class: 'ready-list karaoke-list' });
  const count = h('span', { class: 'badge badge-ok' }, '0');
  const status = h('p', { class: 'small muted' }, 'Conectando con la sala…');
  const audioNote = h('p', { class: 'small muted' }, '🔊 El micrófono autorizado suena por la salida de audio de este equipo. Para cancelación de eco o varios micrófonos usa el panel del DJ.');
  const mixer = renderMixer(options.music ?? null);
  const panel = h(
    'section',
    { class: 'panel karaoke-host' },
    h('div', { class: 'row space' }, h('h2', null, '🎤 Quieren cantar ', count), h('div', { class: 'actions' }, button('Panel del DJ', () => navigate(djPanelUrl(endpoint)), 'btn btn-sm'))),
    h('p', { class: 'small muted' }, 'Los jugadores pulsan "Quiero cantar" en su tarjeta y aparecen aquí. Pulsa Autorizar para tomar su micrófono y sacar su voz por el PA.'),
    list,
    mixer.el,
    audioNote,
    status,
  );
  const draw = () => {
    const w = watcher;
    if (!w) return;
    const items = [...w.dj.participants.values()].filter((p) => p.state !== 'DISCONNECTED').sort(byPriority);
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
      } else if (p.state === 'CONNECTED') {
        actions.appendChild(h('span', { class: 'small muted' }, 'todavía no pulsó Quiero cantar'));
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
    void duckMusic(w);
  };
  void (async () => {
    try {
      if (watcher && watcher.room !== endpoint.roomId) releaseKaraokeWatch();
      if (!watcher) {
        const signaling = await createSignaling(endpoint, 'dj', loadConfig());
        const dj = new DjClient(signaling, endpoint.roomId);
        await dj.connect('Anfitrión');
        const w: Watcher = { dj, room: endpoint.roomId, offs: [], autoLive: new Set(), consumer: null, ctx: null, master: null, playing: new Map(), mix: loadMix(), music: options.music ?? null, musicBefore: null };
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
        if (options.music) watcher.music = options.music;
      }
      mixer.bind(watcher);
      const meter = setInterval(() => (panel.isConnected ? mixer.tick(watcher) : clearInterval(meter)), 100);
      watcher.offs.push(() => clearInterval(meter));
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
  w.master = w.ctx.createGain();
  w.master.connect(w.ctx.destination);
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
  if (!w.ctx || !w.master) return;
  const master = w.master;
  for (const producerId of active) {
    if (w.playing.has(producerId)) continue;
    const placeholder = { stop: () => undefined };
    w.playing.set(producerId, placeholder);
    try {
      const source = await w.consumer.consume(producerId);
      if (watcher !== w || w.playing.get(producerId) !== placeholder) return;
      const ctx = w.ctx;
      // Cadena de voz: paso alto → EQ → ganancia → compresor → limitador. Sin esto el teléfono se pierde bajo la música.
      const chain = new VoiceChain(ctx);
      applyMix(chain, w.mix);
      chain.output.connect(master);
      if (source instanceof MediaStream) {
        // Un elemento <audio> mantiene viva la pista WebRTC; el AudioContext la saca por la salida por defecto.
        const el = new Audio();
        el.srcObject = source;
        el.muted = true;
        void el.play().catch(() => undefined);
        chain.setSource(source);
        w.playing.set(producerId, { chain, stop: () => { chain.dispose(); el.pause(); el.srcObject = null; } });
      } else {
        chain.setSource(source);
        w.playing.set(producerId, { chain, stop: () => { chain.dispose(); source.disconnect(); } });
      }
    } catch (err) {
      w.playing.delete(producerId);
      toast(`No se pudo recibir el micrófono: ${errorMessage(err)}`, 'error');
    }
  }
}

/* ---------------- Mezcla: voz procesada y música que baja mientras cantan ---------------- */

function applyMix(chain: VoiceChain, mix: MixSettings): void {
  chain.applyPreset(mix.preset);
  chain.setGainDb(mix.voiceDb);
  chain.setProcessing(mix.processing);
}

function applyMixToAll(w: Watcher): void {
  for (const p of w.playing.values()) if (p.chain) applyMix(p.chain, w.mix);
}

/** Baja la música mientras haya un micrófono en vivo y la devuelve a su nivel cuando no queda ninguno. */
async function duckMusic(w: Watcher): Promise<void> {
  if (!w.music) return;
  const singing = w.dj.slots.some((s) => s.state === 'LIVE');
  try {
    if (singing && w.mix.autoDuck) {
      if (w.musicBefore === null) w.musicBefore = w.music.get();
      const target = Math.min(w.musicBefore, w.mix.musicWhileSinging / 100);
      if (Math.abs(w.music.get() - target) > 0.02) await w.music.set(target);
    } else await restoreMusic(w);
  } catch {
    /* el reproductor puede no estar disponible todavía */
  }
}

async function restoreMusic(w: Watcher): Promise<void> {
  if (w.musicBefore === null || !w.music) return;
  const before = w.musicBefore;
  w.musicBefore = null;
  await w.music.set(before);
}

function renderMixer(music: MusicControl | null): { el: HTMLElement; bind(w: Watcher): void; tick(w: Watcher | null): void } {
  const mix = loadMix();
  const voice = h('input', { type: 'range', min: '-12', max: '30', step: '1', value: String(mix.voiceDb), class: 'volume' });
  const voiceLabel = h('span', { class: 'mix-value' }, fmtDb(mix.voiceDb));
  const meterFill = h('div', { class: 'level-fill' });
  const meter = h('div', { class: 'level-meter' }, meterFill);
  const preset = h('select', { class: 'input' }, h('option', { value: 'SING' }, 'Cantar'), h('option', { value: 'TALK' }, 'Hablar'));
  preset.value = mix.preset;
  const processing = h('input', { type: 'checkbox', checked: mix.processing });
  const duck = h('input', { type: 'range', min: '0', max: '100', step: '5', value: String(mix.musicWhileSinging), class: 'volume' });
  const duckLabel = h('span', { class: 'mix-value' }, `${mix.musicWhileSinging}%`);
  const autoDuck = h('input', { type: 'checkbox', checked: mix.autoDuck });
  let bound: Watcher | null = null;
  const commit = () => {
    mix.voiceDb = Number(voice.value);
    mix.preset = preset.value === 'TALK' ? 'TALK' : 'SING';
    mix.processing = processing.checked;
    mix.musicWhileSinging = Number(duck.value);
    mix.autoDuck = autoDuck.checked;
    voiceLabel.textContent = fmtDb(mix.voiceDb);
    duckLabel.textContent = `${mix.musicWhileSinging}%`;
    saveMix(mix);
    if (bound) {
      bound.mix = { ...mix };
      applyMixToAll(bound);
      void duckMusic(bound);
    }
  };
  const reset = button('Valores recomendados', () => {
    Object.assign(mix, DEFAULT_MIX);
    voice.value = String(mix.voiceDb);
    preset.value = mix.preset;
    processing.checked = mix.processing;
    duck.value = String(mix.musicWhileSinging);
    autoDuck.checked = mix.autoDuck;
    commit();
  }, 'btn btn-sm');
  for (const el of [voice, preset, processing, duck, autoDuck]) el.addEventListener('input', commit);
  const el = h(
    'details',
    { class: 'karaoke-mix' },
    h('summary', null, '🎚 Mezcla de voz y música'),
    h('label', { class: 'field mix-row' }, h('span', null, 'Voz del micrófono'), voice, voiceLabel),
    h('div', { class: 'row mix-row' }, h('span', { class: 'small muted' }, 'Nivel'), meter),
    h('label', { class: 'field mix-row' }, h('span', null, 'Ajuste'), preset),
    h('label', { class: 'field-check small' }, processing, h('span', null, 'Procesar la voz (filtro de graves, ecualizador, compresor y limitador)')),
    music
      ? h('label', { class: 'field mix-row' }, h('span', null, 'Música mientras cantan'), duck, duckLabel)
      : h('p', { class: 'small muted' }, 'Para que la música baje sola mientras cantan, elige el reproductor en la pantalla del anfitrión.'),
    music ? h('label', { class: 'field-check small' }, autoDuck, h('span', null, 'Bajar la música automáticamente al dar paso a un micrófono')) : null,
    h('div', { class: 'actions' }, reset),
  );
  return {
    el,
    bind: (w) => {
      bound = w;
      w.mix = { ...mix };
      applyMixToAll(w);
    },
    tick: (w) => {
      let level = 0;
      for (const p of w?.playing.values() ?? []) if (p.chain) level = Math.max(level, p.chain.level());
      meterFill.style.width = `${Math.round(level * 100)}%`;
    },
  };
}

function fmtDb(db: number): string {
  return `${db > 0 ? '+' : ''}${db} dB`;
}

function byPriority(a: ParticipantInfo, b: ParticipantInfo): number {
  const order: ParticipantState[] = ['LIVE', 'MUTED', 'PREPARED', 'PREPARING', 'READY', 'ERROR', 'CONNECTED', 'DISCONNECTED'];
  const d = order.indexOf(a.state) - order.indexOf(b.state);
  return d !== 0 ? d : (a.timestampReady ?? 0) - (b.timestampReady ?? 0);
}
