/**
 * Panel "📡 Transmitir a los jugadores" de la pantalla del anfitrión: micrófono del animador + música + cantantes del
 * karaoke salen como una sola transmisión de audio por el servidor Live; los jugadores la oyen desde su tarjeta y,
 * cuando el animador les da paso (panel "Quieren cantar"), su voz entra en la misma mezcla. Para cámara, el panel
 * del animador (#/live) sigue disponible.
 */

import { button, errorMessage, h, toast } from '../../dom.js';
import { loadToken } from '../../concert/store.js';
import type { GameState } from '../../store.js';
import { BroadcastMixer, loadBroadcastSettings, saveBroadcastSettings, type MusicSource } from '../broadcast.js';
import { LIVE_EVENTS } from '../protocol.js';
import { LiveHostPublisher } from '../publisher.js';
import { liveSession } from '../session.js';
import { liveLinkOf } from './host-panel.js';

let active: { mixer: BroadcastMixer; publisher: LiveHostPublisher; offs: (() => void)[] } | null = null;

export async function releaseBroadcast(): Promise<void> {
  const a = active;
  active = null;
  if (!a) return;
  a.offs.forEach((off) => off());
  await a.publisher.stop().catch(() => undefined);
  a.mixer.dispose();
}

export function broadcasting(): boolean {
  return active !== null;
}

export function renderBroadcastPanel(game: GameState): HTMLElement {
  const link = liveLinkOf(game);
  const settings = loadBroadcastSettings();
  const status = h('p', { class: 'small muted' }, '⚪ Sin transmitir');
  const listeners = h('span', { class: 'badge' }, '👥 0');
  const micSel = h('select', { class: 'input' }, h('option', { value: '' }, 'Micrófono por defecto'));
  const musicSel = h('select', { class: 'input' }, h('option', { value: 'none' }, 'Sin música (solo voz)'), h('option', { value: 'device' }, 'Entrada de audio (mezclador / loopback)'), h('option', { value: 'tab' }, 'Audio de esta pestaña (Spotify en este navegador)'));
  musicSel.value = settings.musicSource;
  const musicDev = h('select', { class: 'input' }, h('option', { value: '' }, 'Entrada por defecto'));
  const micDb = h('input', { type: 'range', min: '-12', max: '24', step: '1', value: String(settings.micDb), class: 'volume' });
  const micDbLabel = h('span', { class: 'mix-value' }, fmtDb(settings.micDb));
  const musicDb = h('input', { type: 'range', min: '-30', max: '12', step: '1', value: String(settings.musicDb), class: 'volume' });
  const musicDbLabel = h('span', { class: 'mix-value' }, fmtDb(settings.musicDb));
  const monitor = h('input', { type: 'checkbox', checked: settings.monitor });
  const micMeter = h('div', { class: 'level-fill' });
  const mixMeter = h('div', { class: 'level-fill' });
  const startBtn = button('📡 Iniciar transmisión', () => void start(), 'btn btn-primary');
  const stopBtn = button('■ Detener', () => void stop(), 'btn btn-danger');
  const muteBtn = button('🎙 Silenciar mi micrófono', () => toggleMute(), 'btn');
  stopBtn.hidden = true;
  muteBtn.hidden = true;
  const musicDevRow = h('label', { class: 'field mix-row' }, h('span', null, 'Entrada de música'), musicDev);
  const syncMusicRows = () => {
    musicDevRow.hidden = musicSel.value !== 'device';
  };
  syncMusicRows();

  const panel = h(
    'section',
    { class: 'panel broadcast-panel' },
    h('div', { class: 'row space' }, h('h2', null, '📡 Transmitir a los jugadores'), listeners),
    h('p', { class: 'small muted' }, 'Tu voz, la música y quien cante salen juntos a todos los que abrieron el QR. Para cámara usa "🎥 Transmitir".'),
    status,
    h('label', { class: 'field mix-row' }, h('span', null, 'Mi micrófono'), micSel),
    h('label', { class: 'field mix-row' }, h('span', null, 'Mi voz'), micDb, micDbLabel),
    h('div', { class: 'row mix-row' }, h('span', { class: 'small muted' }, 'Nivel voz'), h('div', { class: 'level-meter' }, micMeter)),
    h('label', { class: 'field mix-row' }, h('span', null, 'Música'), musicSel),
    musicDevRow,
    h('label', { class: 'field mix-row' }, h('span', null, 'Volumen música'), musicDb, musicDbLabel),
    h('label', { class: 'field-check small' }, monitor, h('span', null, 'Escuchar la música y los cantantes también en este equipo')),
    h('div', { class: 'row mix-row' }, h('span', { class: 'small muted' }, 'Nivel enviado'), h('div', { class: 'level-meter' }, mixMeter)),
    h('div', { class: 'actions' }, startBtn, stopBtn, muteBtn),
  );
  if (!link) {
    status.textContent = 'Activa Bingo Hit Live (en los ajustes de abajo) para poder transmitir.';
    startBtn.disabled = true;
    return panel;
  }

  const persist = () => {
    settings.micId = micSel.value;
    settings.micDb = Number(micDb.value);
    settings.musicSource = musicSel.value as MusicSource;
    settings.musicDeviceId = musicDev.value;
    settings.musicDb = Number(musicDb.value);
    settings.monitor = monitor.checked;
    micDbLabel.textContent = fmtDb(settings.micDb);
    musicDbLabel.textContent = fmtDb(settings.musicDb);
    saveBroadcastSettings(settings);
  };
  micDb.addEventListener('input', () => {
    persist();
    active?.mixer.setMicDb(settings.micDb);
  });
  musicDb.addEventListener('input', () => {
    persist();
    active?.mixer.setMusicDb(settings.musicDb);
  });
  monitor.addEventListener('change', () => {
    persist();
    active?.mixer.setMonitor(settings.monitor);
  });
  micSel.addEventListener('change', () => {
    persist();
    if (active) void active.mixer.setMic(settings.micId, settings.micDb).catch((err) => toast(errorMessage(err), 'error'));
  });
  const applyMusic = async () => {
    persist();
    syncMusicRows();
    if (!active) return;
    try {
      await active.mixer.setMusic(settings.musicSource, settings.musicDeviceId, settings.musicDb);
    } catch (err) {
      toast(`Música: ${errorMessage(err)}`, 'error');
    }
  };
  musicSel.addEventListener('change', () => void applyMusic());
  musicDev.addEventListener('change', () => void applyMusic());

  const fillDevices = async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const inputs = all.filter((d) => d.kind === 'audioinput');
      for (const [sel, saved] of [[micSel, settings.micId], [musicDev, settings.musicDeviceId]] as const) {
        while (sel.options.length > 1) sel.remove(1);
        for (const d of inputs) sel.appendChild(h('option', { value: d.deviceId }, d.label || `Entrada ${sel.options.length}`));
        sel.value = inputs.some((d) => d.deviceId === saved) ? saved : '';
      }
    } catch {
      /* sin permisos todavía: etiquetas vacías */
    }
  };
  void fillDevices();

  const setStatus = (text: string, live: boolean) => {
    status.textContent = text;
    status.className = live ? 'small ok' : 'small muted';
    startBtn.hidden = live;
    stopBtn.hidden = !live;
    muteBtn.hidden = !live;
  };

  let meterTimer: ReturnType<typeof setInterval> | null = null;
  const start = async () => {
    if (active) return;
    startBtn.disabled = true;
    setStatus('Abriendo micrófono…', false);
    try {
      const mixer = new BroadcastMixer();
      await mixer.setMic(settings.micId, settings.micDb);
      await fillDevices();
      mixer.setMonitor(settings.monitor);
      try {
        await mixer.setMusic(settings.musicSource, settings.musicDeviceId, settings.musicDb);
      } catch (err) {
        toast(`Se transmite solo la voz. Música: ${errorMessage(err)}`, 'error');
      }
      const session = liveSession(link, { token: loadToken(), name: 'Animador' });
      const publisher = new LiveHostPublisher(session);
      publisher.useStream(mixer.stream);
      setStatus('Conectando con el servidor…', false);
      await publisher.goLive();
      const offs = [
        session.on(LIVE_EVENTS.playersCount, (p: { viewers: number }) => (listeners.textContent = `👥 ${p.viewers}`)),
        session.onState((s) => {
          if (!active) return;
          if (s === 'LIVE') setStatus(`🔴 Transmitiendo${mixer.musicActive ? ' voz + música' : ' (solo voz)'}`, true);
          else if (s === 'RECONNECTING') setStatus('🟡 Reconectando…', true);
          else setStatus('🔴 Sin conexión con el servidor', true);
        }),
      ];
      active = { mixer, publisher, offs };
      listeners.textContent = `👥 ${session.ack?.viewers ?? 0}`;
      setStatus(`🔴 Transmitiendo${mixer.musicActive ? ' voz + música' : ' (solo voz)'}`, true);
      meterTimer = setInterval(() => {
        if (!active || !panel.isConnected) {
          if (meterTimer) clearInterval(meterTimer);
          return;
        }
        micMeter.style.width = `${Math.round(active.mixer.micLevel() * 100)}%`;
        mixMeter.style.width = `${Math.round(active.mixer.level() * 100)}%`;
      }, 100);
      toast('Transmisión iniciada: los jugadores ya te oyen', 'success');
    } catch (err) {
      await releaseBroadcast();
      setStatus('⚪ Sin transmitir', false);
      toast(`No se pudo transmitir: ${errorMessage(err)}`, 'error');
    } finally {
      startBtn.disabled = false;
    }
  };
  const stop = async () => {
    await releaseBroadcast();
    micMeter.style.width = '0%';
    mixMeter.style.width = '0%';
    muteBtn.textContent = '🎙 Silenciar mi micrófono';
    setStatus('⚪ Sin transmitir', false);
  };
  const toggleMute = () => {
    if (!active) return;
    const muted = !active.mixer.micMuted;
    active.mixer.setMicMuted(muted);
    muteBtn.textContent = muted ? '🎙 Activar mi micrófono' : '🎙 Silenciar mi micrófono';
  };
  if (active) setStatus('🔴 Transmitiendo', true); // la pantalla se volvió a pintar sin cortar la transmisión
  return panel;
}

function fmtDb(db: number): string {
  return `${db > 0 ? '+' : ''}${db} dB`;
}
