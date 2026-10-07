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
import { LiveViewer } from '../viewer.js';
import { liveLinkOf } from './host-panel.js';

let active: { mixer: BroadcastMixer; publisher: LiveHostPublisher; offs: (() => void)[]; guestViewer: LiveViewer | null } | null = null;
let launcher: ((opts: { camera?: boolean }) => Promise<void>) | null = null;

/** Arranca la transmisión desde fuera del panel (botón "🎥 Transmitir" de la cabecera): cámara + voz + música, un solo camino. */
export async function startBroadcast(opts: { camera?: boolean } = {}): Promise<void> {
  if (!launcher) throw new Error('El panel de transmisión no está en pantalla');
  await launcher(opts);
}

export async function releaseBroadcast(): Promise<void> {
  launcher = null;
  const a = active;
  active = null;
  if (!a) return;
  a.offs.forEach((off) => off());
  a.guestViewer?.stop();
  await a.publisher.stop().catch(() => undefined);
  a.mixer.dispose();
}

export function broadcasting(): boolean {
  return active !== null;
}

/** Aviso fijo "🔴 Transmitiendo" en las demás pantallas, con vuelta a la partida y Detener. */
export function renderBroadcastPill(path: string): void {
  let pill = document.getElementById('broadcast-pill');
  if (!active || path === '/host') {
    pill?.remove();
    return;
  }
  if (pill) return;
  pill = h(
    'div',
    { id: 'broadcast-pill', class: 'broadcast-pill' },
    h('span', null, '🔴 Transmitiendo a los jugadores'),
    button('Volver a la partida', () => { location.hash = '#/host'; }, 'btn btn-sm btn-primary'),
    button('■ Detener', () => void releaseBroadcast().then(() => document.getElementById('broadcast-pill')?.remove()), 'btn btn-sm btn-danger'),
  );
  document.body.appendChild(pill);
}

export function renderBroadcastPanel(game: GameState): HTMLElement {
  const link = liveLinkOf(game);
  const settings = loadBroadcastSettings();
  const status = h('p', { class: 'small muted' }, '⚪ Sin transmitir');
  const listeners = h('span', { class: 'badge' }, '👥 0');
  const micSel = h('select', { class: 'input' }, h('option', { value: '' }, 'Micrófono por defecto'));
  const fromLibrary = game.source === 'library';
  const musicSel = h(
    'select',
    { class: 'input' },
    fromLibrary ? h('option', { value: 'local' }, 'Biblioteca propia (la música de esta partida)') : null,
    h('option', { value: 'none' }, 'Sin música (solo voz)'),
    h('option', { value: 'device' }, 'Entrada de audio (mezclador / loopback)'),
    h('option', { value: 'tab' }, 'Audio de esta pestaña (Spotify en este navegador)'),
  );
  // Con biblioteca propia la música entra directa. Con Spotify, por defecto se captura el audio de esta pestaña
  // (el navegador pide "Compartir audio"); si la captura llega muda, se avisa y se sugiere la biblioteca o un loopback.
  musicSel.value = fromLibrary ? (settings.musicSource === 'local' || settings.musicSource === 'none' ? 'local' : settings.musicSource) : settings.musicSource === 'local' || settings.musicSource === 'none' ? 'tab' : settings.musicSource;
  settings.musicSource = musicSel.value as MusicSource;
  const musicHint = h('p', { class: 'small muted' }, fromLibrary ? 'La música de la biblioteca entra directa en la transmisión.' : 'Partida con Spotify: al iniciar, el navegador pedirá compartir esta pestaña; marca "Compartir audio de la pestaña". Si no se oye música, usa Mi biblioteca (recomendado) o una entrada de audio (loopback / mezclador).');
  const musicDev = h('select', { class: 'input' }, h('option', { value: '' }, 'Entrada por defecto'));
  const micDb = h('input', { type: 'range', min: '-12', max: '24', step: '1', value: String(settings.micDb), class: 'volume' });
  const micDbLabel = h('span', { class: 'mix-value' }, fmtDb(settings.micDb));
  const musicDb = h('input', { type: 'range', min: '-30', max: '12', step: '1', value: String(settings.musicDb), class: 'volume' });
  const musicDbLabel = h('span', { class: 'mix-value' }, fmtDb(settings.musicDb));
  const monitor = h('input', { type: 'checkbox', checked: settings.monitor });
  const camera = h('input', { type: 'checkbox', checked: settings.camera });
  const camSel = h('select', { class: 'input' }, h('option', { value: '' }, 'Cámara por defecto'));
  const camPreview = h('video', { class: 'broadcast-cam', autoplay: true, playsInline: true, muted: true, hidden: true });
  camPreview.setAttribute('playsinline', '');
  const camRow = h('label', { class: 'field mix-row' }, h('span', null, 'Cámara'), camSel);
  camRow.hidden = !settings.camera;
  const guestVideo = h('video', { autoplay: true, playsInline: true, muted: true });
  guestVideo.setAttribute('playsinline', '');
  const guestLabel = h('p', { class: 'small muted' }, '');
  const guestBox = h('div', { class: 'broadcast-guest', hidden: true }, guestLabel, guestVideo);
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
    musicHint,
    musicDevRow,
    h('label', { class: 'field mix-row' }, h('span', null, 'Volumen música'), musicDb, musicDbLabel),
    h('label', { class: 'field-check small' }, monitor, h('span', null, 'Escuchar la música y los cantantes también en este equipo')),
    h('label', { class: 'field-check small' }, camera, h('span', null, '📷 Emitir también mi cámara (los jugadores me ven sobre su cartón)')),
    camRow,
    camPreview,
    guestBox,
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
    settings.camera = camera.checked;
    settings.cameraId = camSel.value;
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
  camera.addEventListener('change', () => {
    persist();
    camRow.hidden = !settings.camera;
    if (active) toast('La cámara se aplica al iniciar la transmisión: detén y vuelve a iniciar.', 'info');
  });
  camSel.addEventListener('change', persist);
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
      const cams = all.filter((d) => d.kind === 'videoinput');
      while (camSel.options.length > 1) camSel.remove(1);
      for (const d of cams) camSel.appendChild(h('option', { value: d.deviceId }, d.label || `Cámara ${camSel.options.length}`));
      camSel.value = cams.some((d) => d.deviceId === settings.cameraId) ? settings.cameraId : '';
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

  const describe = (mixer: BroadcastMixer, musicOk = true) => {
    const parts = ['voz'];
    if (mixer.musicActive) parts.push(musicOk ? 'música' : 'música sin señal');
    if (mixer.cameraOn) parts.push('cámara');
    return `🔴 Transmitiendo ${parts.join(' + ')}`;
  };
  let meterTimer: ReturnType<typeof setInterval> | null = null;
  let musicSilentSince: number | null = null;
  let musicWarned = false;
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
      if (settings.camera) {
        try {
          camPreview.srcObject = await mixer.setCamera(settings.cameraId);
          camPreview.hidden = false;
        } catch (err) {
          toast(`Se transmite sin cámara: ${errorMessage(err)}`, 'error');
        }
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
          if (s === 'LIVE') setStatus(describe(mixer), true);
          else if (s === 'RECONNECTING') setStatus('🟡 Reconectando…', true);
          else setStatus('🔴 Sin conexión con el servidor', true);
        }),
      ];
      // Cámara del invitado que canta o habla: el animador la ve aquí (sin consumir su propia transmisión).
      const guestViewer = new LiveViewer(session, {
        onGuest: (stream, name) => {
          guestBox.hidden = !stream;
          guestVideo.srcObject = stream;
          guestLabel.textContent = stream ? `🎤 ${name || 'Invitado'} en cámara` : '';
          if (stream) void guestVideo.play().catch(() => undefined);
        },
      }, { only: 'guest' });
      void guestViewer.start().catch(() => undefined);
      active = { mixer, publisher, offs, guestViewer };
      listeners.textContent = `👥 ${session.ack?.viewers ?? 0}`;
      setStatus(describe(mixer), true);
      startMeter();
      toast('Transmisión iniciada: los jugadores ya te oyen', 'success');
    } catch (err) {
      await releaseBroadcast();
      setStatus('⚪ Sin transmitir', false);
      toast(`No se pudo transmitir: ${errorMessage(err)}`, 'error');
    } finally {
      startBtn.disabled = false;
    }
  };
  const startMeter = () => {
    musicSilentSince = null;
    musicWarned = false;
    if (meterTimer) clearInterval(meterTimer);
    meterTimer = setInterval(() => {
        if (!active || !panel.isConnected) {
          if (meterTimer) clearInterval(meterTimer);
          return;
        }
        micMeter.style.width = `${Math.round(active.mixer.micLevel() * 100)}%`;
        mixMeter.style.width = `${Math.round(active.mixer.level() * 100)}%`;
        // Captura muda (Spotify protegido, pestaña equivocada, loopback sin señal): avisar tras 8 s sin música.
        if (active.mixer.musicActive && active.mixer.musicKind !== 'local') {
          if (active.mixer.musicLevel() > 0.01) {
            musicSilentSince = null;
            if (musicWarned) {
              musicWarned = false;
              setStatus(describe(active.mixer), true);
            }
          } else {
            musicSilentSince ??= Date.now();
            if (!musicWarned && Date.now() - musicSilentSince > 8000) {
              musicWarned = true;
              setStatus(describe(active.mixer, false), true);
              toast('La música no está llegando a la transmisión. Si es Spotify, el navegador no deja capturarla: usa Mi biblioteca o una entrada de audio (loopback / mezclador).', 'error');
            }
          }
        }
      }, 100);
  };
  const stop = async () => {
    await releaseBroadcast();
    camPreview.srcObject = null;
    camPreview.hidden = true;
    guestBox.hidden = true;
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
  if (active) {
    // La pantalla se volvió a pintar (o se volvió de otra) sin cortar la transmisión: estado, medidores y cámara.
    setStatus(describe(active.mixer), true);
    startMeter();
    if (active.mixer.cameraOn) {
      camPreview.srcObject = active.mixer.stream;
      camPreview.hidden = false;
    }
  }
  launcher = async (opts) => {
    if (opts.camera !== undefined) {
      camera.checked = opts.camera;
      persist();
      camRow.hidden = !settings.camera;
    }
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!active) await start();
  };
  return panel;
}

function fmtDb(db: number): string {
  return `${db > 0 ? '+' : ''}${db} dB`;
}
