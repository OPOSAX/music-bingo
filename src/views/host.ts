/** Pantalla del anfitrión: reproduce fragmentos, lleva la cuenta y verifica tarjetas. */

import type { Card, Track } from '../bingo.js';
import { cardLabel, evaluateCard, generateCard } from '../bingo.js';
import { button, clear, errorMessage, formatDuration, h, toast } from '../dom.js';
import { SnippetPlayer, createBrowserPlayer, snippetStart } from '../player.js';
import { navigate } from '../router.js';
import * as api from '../spotify-api.js';
import type { GameState } from '../store.js';
import { calledSet, currentTrackIndex, gameCards, loadGame, saveGame } from '../store.js';
import { renderCardGrid } from './card-grid.js';

let snippetPlayer: SnippetPlayer | null = null;
let browserPlayer: Spotify.Player | null = null;

export async function renderHost(root: HTMLElement): Promise<void> {
  clear(root);
  const loaded = loadGame();
  if (!loaded) {
    root.appendChild(h('section', { class: 'panel' }, h('h2', null, 'No hay ninguna partida'), button('Crear partida', () => navigate('/setup'), 'btn btn-primary')));
    return;
  }
  const game: GameState = loaded;
  const cards = gameCards(game);

  root.appendChild(
    h(
      'header',
      { class: 'page-header' },
      h('div', null, h('h1', null, `Partida ${game.config.seed}`), h('p', { class: 'muted' }, `${game.playlistName} · ${game.tracks.length} canciones · ${cards.length} tarjetas · ${game.config.gridSize}×${game.config.gridSize}`)),
      h('div', { class: 'actions' }, button('Tarjetas', () => navigate('/cards'), 'btn'), button('Inicio', () => navigate('/'), 'btn btn-link')),
    ),
  );

  /* ---- Reproductor ---- */
  const deviceStatus = h('p', { class: 'muted' }, 'Sin dispositivo de reproducción.');
  const deviceList = h('div', { class: 'device-list' });
  const playerPanel = h('section', { class: 'panel' }, h('h2', null, 'Reproductor'), deviceStatus, deviceList);
  root.appendChild(playerPanel);

  const setDevice = (id: string, name: string) => {
    snippetPlayer = new SnippetPlayer(id);
    deviceStatus.textContent = `Reproduciendo en: ${name}`;
    deviceStatus.className = 'ok';
    refreshControls();
  };

  const volume = h('input', { type: 'range', min: '0', max: '100', value: '80', class: 'volume' });
  volume.addEventListener('input', () => browserPlayer?.setVolume(Number(volume.value) / 100));

  const browserBtn = button('▶ Usar este navegador', () => void startBrowserPlayer(), 'btn btn-primary');
  const startBrowserPlayer = async () => {
    browserBtn.disabled = true;
    deviceStatus.textContent = 'Conectando el reproductor del navegador…';
    try {
      const { deviceId, player } = await createBrowserPlayer('Bingo musical', (msg) => toast(msg, 'error'));
      browserPlayer = player;
      setDevice(deviceId, 'este navegador');
      browserBtn.remove();
      deviceList.appendChild(h('label', { class: 'field' }, h('span', null, 'Volumen'), volume));
    } catch (err) {
      browserBtn.disabled = false;
      deviceStatus.textContent = errorMessage(err);
      deviceStatus.className = 'alert alert-error';
    }
  };

  const refreshDevices = async () => {
    try {
      const devices = await api.getDevices();
      deviceList.querySelectorAll('.device-btn').forEach((el) => el.remove());
      for (const d of devices) {
        deviceList.appendChild(button(`${d.is_active ? '● ' : ''}${d.name} (${d.type})`, () => setDevice(d.id, d.name), 'btn btn-sm device-btn'));
      }
      if (devices.length === 0) toast('No hay dispositivos de Spotify activos. Abre Spotify en algún dispositivo o usa este navegador.', 'info');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  if (snippetPlayer && browserPlayer) {
    setDevice(snippetPlayer.deviceId, 'este navegador');
    deviceList.appendChild(h('label', { class: 'field' }, h('span', null, 'Volumen'), volume));
  } else {
    deviceList.appendChild(browserBtn);
  }
  deviceList.appendChild(button('Otros dispositivos…', () => void refreshDevices(), 'btn'));

  /* ---- Juego ---- */
  const counter = h('span', { class: 'counter' });
  const nowPlaying = h('div', { class: 'now-playing' });
  const progress = h('div', { class: 'progress' }, h('div', { class: 'progress-bar' }));
  const progressBar = progress.firstElementChild as HTMLElement;
  const nextBtn = button('Siguiente canción ▶', () => void next(), 'btn btn-primary btn-xl');
  const replayBtn = button('Repetir fragmento', () => void replay(), 'btn');
  const revealBtn = button('Revelar título', () => reveal(), 'btn');
  const stopBtn = button('■ Parar', () => void stop(), 'btn');
  const gamePanel = h('section', { class: 'panel game-panel' }, h('div', { class: 'row space' }, h('h2', null, 'Canción'), counter), nowPlaying, progress, h('div', { class: 'actions' }, nextBtn, replayBtn, revealBtn, stopBtn));
  root.appendChild(gamePanel);

  /* ---- Estado de las tarjetas ---- */
  const winners = h('div', { class: 'winners' });
  const verifyInput = h('input', { class: 'input', type: 'number', min: '1', max: String(cards.length), placeholder: 'Nº de tarjeta' });
  const verifyResult = h('div', { class: 'verify-result' });
  const verifyForm = h('form', { class: 'row' }, verifyInput, h('button', { class: 'btn', type: 'submit' }, 'Comprobar'));
  verifyForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    verify(Number(verifyInput.value) - 1);
  });
  root.appendChild(h('section', { class: 'panel' }, h('h2', null, 'Tarjetas'), winners, h('h3', null, 'Comprobar una tarjeta'), verifyForm, verifyResult));

  /* ---- Historial ---- */
  const history = h('ol', { class: 'history' });
  root.appendChild(h('section', { class: 'panel' }, h('h2', null, 'Canciones cantadas'), history));

  const undoBtn = button('Deshacer última canción', () => undo(), 'btn btn-sm');
  root.appendChild(h('section', { class: 'panel muted-panel' }, h('div', { class: 'actions' }, undoBtn, button('Terminar partida', () => navigate('/'), 'btn btn-link'))));

  let playing = false;

  function refreshControls(): void {
    const finished = game.position >= game.order.length;
    const ready = snippetPlayer !== null;
    nextBtn.disabled = !ready || finished || playing;
    replayBtn.disabled = !ready || game.position === 0 || playing;
    stopBtn.disabled = !playing;
    revealBtn.disabled = game.position === 0 || game.revealed;
    undoBtn.disabled = game.position === 0 || playing;
    nextBtn.textContent = finished ? 'No quedan canciones' : game.position === 0 ? 'Empezar ▶' : 'Siguiente canción ▶';
  }

  function renderNowPlaying(): void {
    clear(nowPlaying);
    const idx = currentTrackIndex(game);
    counter.textContent = `${game.position} / ${game.order.length}`;
    if (idx === null) {
      nowPlaying.appendChild(h('p', { class: 'muted' }, 'Pulsa "Empezar" cuando todos tengan su tarjeta.'));
      return;
    }
    const track = game.tracks[idx] as Track;
    if (game.revealed) {
      nowPlaying.appendChild(h('div', { class: 'track-big' }, track.image ? h('img', { src: track.image, alt: '' }) : null, h('div', null, h('div', { class: 'track-title' }, track.name), h('div', { class: 'track-artist' }, track.artists))));
    } else {
      nowPlaying.appendChild(h('div', { class: 'track-big hidden-track' }, h('div', { class: 'track-title' }, '¿Qué canción es?'), h('div', { class: 'track-artist' }, `Canción nº ${game.position} · ${formatDuration(track.durationMs)}`)));
    }
  }

  function renderHistory(): void {
    clear(history);
    const called = game.order.slice(0, game.position);
    for (let i = called.length - 1; i >= 0; i--) {
      const track = game.tracks[called[i] as number] as Track;
      const hiddenCurrent = i === called.length - 1 && !game.revealed;
      history.appendChild(h('li', null, h('span', { class: 'history-n' }, `${i + 1}.`), hiddenCurrent ? h('em', { class: 'muted' }, 'sin revelar') : `${track.name} — ${track.artists}`));
    }
    if (called.length === 0) history.appendChild(h('li', { class: 'muted' }, 'Todavía no ha sonado ninguna canción.'));
  }

  function renderWinners(): void {
    clear(winners);
    const called = calledSet(game);
    const full: number[] = [];
    const line: number[] = [];
    let closest = Infinity;
    for (const card of cards) {
      const ev = evaluateCard(card, called);
      if (ev.status === 'full') full.push(card.index + 1);
      else if (ev.status === 'line') line.push(card.index + 1);
      closest = Math.min(closest, ev.remaining);
    }
    const stat = (label: string, list: number[], cls: string) => h('p', { class: `stat ${cls}` }, h('strong', null, `${label}: `), list.length ? list.map((n) => `#${n}`).join(', ') : 'ninguna');
    winners.appendChild(stat('🎉 Bingo (tarjeta completa)', full, full.length ? 'stat-full' : ''));
    winners.appendChild(stat('➖ Línea', line, line.length ? 'stat-line' : ''));
    if (game.position > 0 && full.length === 0) winners.appendChild(h('p', { class: 'muted small' }, `A la tarjeta más avanzada le faltan ${closest} canciones para el bingo.`));
  }

  function verify(index: number): void {
    clear(verifyResult);
    if (!Number.isInteger(index) || index < 0 || index >= cards.length) {
      verifyResult.appendChild(h('p', { class: 'alert alert-error' }, `Introduce un número entre 1 y ${cards.length}.`));
      return;
    }
    const card: Card = generateCard(game.config, game.tracks.length, index);
    const ev = evaluateCard(card, calledSet(game));
    const highlighted = new Set(ev.completedLines.flat());
    const verdict = ev.status === 'full' ? '✅ ¡BINGO! Tarjeta completa.' : ev.status === 'line' ? `✅ Línea válida (${ev.completedLines.length}).` : `❌ Sin línea. Faltan ${ev.remaining} canciones.`;
    verifyResult.appendChild(h('p', { class: `verdict verdict-${ev.status}` }, `${cardLabel(game.config.seed, index)}: ${verdict}`));
    verifyResult.appendChild(
      renderCardGrid({
        gridSize: card.gridSize,
        cells: card.cells.map((c) => (c === null ? null : { title: (game.tracks[c] as Track).name, subtitle: (game.tracks[c] as Track).artists })),
        marked: ev.marked,
        highlighted,
        compact: true,
      }),
    );
  }

  function persist(): void {
    saveGame(game);
    renderNowPlaying();
    renderHistory();
    renderWinners();
    refreshControls();
  }

  async function playCurrent(): Promise<void> {
    const idx = currentTrackIndex(game);
    if (idx === null || !snippetPlayer) return;
    const track = game.tracks[idx] as Track;
    const start = snippetStart(track, game.config.startMode, game.config.snippetSeconds);
    playing = true;
    refreshControls();
    try {
      await snippetPlayer.play(track, start, game.config.snippetSeconds, {
        onTick: (elapsed, total) => {
          progressBar.style.width = `${(elapsed / total) * 100}%`;
        },
        onEnd: () => {
          playing = false;
          refreshControls();
        },
      });
    } catch (err) {
      playing = false;
      refreshControls();
      toast(errorMessage(err), 'error');
    }
  }

  async function next(): Promise<void> {
    if (game.position >= game.order.length) return;
    game.position++;
    game.revealed = false;
    persist();
    await playCurrent();
  }

  async function replay(): Promise<void> {
    await playCurrent();
  }

  async function stop(): Promise<void> {
    await snippetPlayer?.stop();
    playing = false;
    progressBar.style.width = '0%';
    refreshControls();
  }

  function reveal(): void {
    game.revealed = true;
    persist();
  }

  function undo(): void {
    if (game.position === 0) return;
    if (!confirm('¿Deshacer la última canción? Dejará de contar como cantada.')) return;
    game.position--;
    game.revealed = true;
    persist();
  }

  persist();
  refreshControls();
}

/** Cierra el reproductor del navegador al salir de la pantalla. */
export function releasePlayer(): void {
  void snippetPlayer?.stop();
}
