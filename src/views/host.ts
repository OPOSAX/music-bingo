/** Pantalla del anfitrión: reproduce fragmentos, lleva la cuenta y verifica tarjetas. */

import type { Card, Track } from '../bingo.js';
import { cardLabel, evaluateCard, generateCard } from '../bingo.js';
import { button, clear, errorMessage, formatDuration, h, toast } from '../dom.js';
import { SnippetPlayer, createBrowserPlayer, snippetStart } from '../player.js';
import { navigate } from '../router.js';
import * as api from '../spotify-api.js';
import type { GameState } from '../store.js';
import { calledSet, cardName, cardTitle, currentTrackIndex, gameCards, loadGame, saveGame, setCardName } from '../store.js';
import { renderCardGrid } from './card-grid.js';
import { buildSyncState, newTopic, publishState, relayBase, type AutoMark } from '../sync.js';

let snippetPlayer: SnippetPlayer | null = null;
let browserPlayer: Spotify.Player | null = null;

/** El Web Playback SDK no funciona en navegadores móviles (Safari de iOS, Chrome de Android). */
function isMobileBrowser(): boolean {
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
}

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
      h('div', { class: 'actions' }, button('📱 Repartir con QR', () => navigate('/deal'), 'btn'), button('Tarjetas', () => navigate('/cards'), 'btn'), button('Inicio', () => navigate('/'), 'btn btn-link')),
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

  const deviceHint = h('p', { class: 'muted small' });
  const refreshDevices = async () => {
    try {
      const devices = await api.getDevices();
      deviceList.querySelectorAll('.device-btn').forEach((el) => el.remove());
      for (const d of devices) {
        deviceList.appendChild(button(`${d.is_active ? '● ' : ''}${d.name} (${d.type})`, () => setDevice(d.id, d.name), 'btn btn-sm device-btn'));
      }
      deviceHint.textContent =
        devices.length === 0
          ? 'Spotify no ve ningún dispositivo. Abre la app de Spotify en el móvil, el ordenador o el altavoz, reproduce algo un segundo y vuelve a pulsar "Buscar dispositivos".'
          : 'Elige dónde debe sonar la música. El punto ● marca el dispositivo activo ahora en Spotify.';
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const mobile = isMobileBrowser();
  if (snippetPlayer && browserPlayer) {
    setDevice(snippetPlayer.deviceId, 'este navegador');
    deviceList.appendChild(h('label', { class: 'field' }, h('span', null, 'Volumen'), volume));
  } else if (!mobile) {
    deviceList.appendChild(browserBtn);
  }
  deviceList.appendChild(button(mobile ? '🔄 Buscar dispositivos' : 'Otros dispositivos…', () => void refreshDevices(), mobile ? 'btn btn-primary' : 'btn'));
  playerPanel.appendChild(deviceHint);
  if (mobile) {
    deviceHint.textContent = 'En el móvil la música suena a través de la app de Spotify: ábrela, reproduce algo un segundo y elige aquí el dispositivo.';
    if (!snippetPlayer) void refreshDevices();
  }

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

  /* ---- Clasificación ---- */
  const winners = h('div', { class: 'winners' });
  const board = h('div', { class: 'leaderboard' });
  let showAll = false;
  const showAllBtn = button('Ver todas las tarjetas', () => { showAll = !showAll; renderWinners(); }, 'btn btn-sm');
  const verifyInput = h('input', { class: 'input', type: 'number', min: '1', max: String(cards.length), placeholder: 'Nº de tarjeta' });
  const verifyResult = h('div', { class: 'verify-result' });
  const verifyForm = h('form', { class: 'row' }, verifyInput, h('button', { class: 'btn', type: 'submit' }, 'Comprobar'));
  verifyForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    verify(Number(verifyInput.value) - 1);
  });
  root.appendChild(
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'row space' }, h('h2', null, 'Clasificación'), showAllBtn),
      h('p', { class: 'muted small' }, 'Según las canciones que han sonado, no según lo que marque cada jugador. Toca una fila para ponerle nombre.'),
      winners,
      board,
      h('h3', null, 'Comprobar una tarjeta'),
      verifyForm,
      verifyResult,
    ),
  );

  /* ---- Sincronización con las tarjetas ---- */
  if (!game.syncTopic) {
    game.syncTopic = newTopic(game.config.seed); // partidas creadas antes de existir la sincronización
    saveGame(game);
  }
  const syncStatus = h('span', { class: 'muted small' }, 'Sin publicar todavía.');
  const autoMarkSelect = h('select', { class: 'input' }, h('option', { value: 'played' }, 'Al sonar la canción'), h('option', { value: 'revealed' }, 'Al revelar el título'), h('option', { value: 'off' }, 'Nunca (marcan a mano)'));
  autoMarkSelect.value = game.config.autoMark ?? 'played';
  autoMarkSelect.addEventListener('change', () => {
    game.config.autoMark = autoMarkSelect.value as AutoMark;
    persist();
  });
  root.appendChild(
    h(
      'section',
      { class: 'panel' },
      h('h2', null, 'Tarjetas escaneadas'),
      h('p', { class: 'muted small' }, 'Las tarjetas abiertas desde el QR reciben en directo lo que va sonando y se marcan solas. Las tarjetas repartidas antes de crear esta partida no se sincronizan.'),
      h('div', { class: 'fields' }, h('label', { class: 'field' }, h('span', null, 'Marcado automático'), autoMarkSelect)),
      h('p', null, h('strong', null, 'Estado: '), syncStatus),
      h('p', { class: 'muted small' }, `Canal: ${relayBase()}`),
    ),
  );

  let publishTimer: number | null = null;
  function publish(): void {
    if (publishTimer !== null) window.clearTimeout(publishTimer);
    publishTimer = window.setTimeout(() => {
      publishTimer = null;
      const state = buildSyncState(game);
      void publishState(game.syncTopic as string, state).then((ok) => {
        syncStatus.textContent = ok ? `Publicado: ${state.called.length} canciones cantadas · ${new Date(state.t).toLocaleTimeString()}` : 'No se pudo publicar (sin conexión con el canal). Las tarjetas no se actualizarán hasta que vuelva.';
        syncStatus.className = ok ? 'ok small' : 'alert-error small';
      });
    }, 300);
  }

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
    clear(board);
    const called = calledSet(game);
    const statusRank: Record<string, number> = { full: 0, line: 1, none: 2 };
    const rows = cards
      .map((card) => ({ card, ev: evaluateCard(card, called) }))
      .sort((a, b) => statusRank[a.ev.status]! - statusRank[b.ev.status]! || a.ev.remaining - b.ev.remaining || b.ev.completedLines.length - a.ev.completedLines.length || a.card.index - b.card.index);

    const full = rows.filter((r) => r.ev.status === 'full').map((r) => cardTitle(game, r.card.index));
    const line = rows.filter((r) => r.ev.status === 'line').map((r) => cardTitle(game, r.card.index));
    if (full.length) winners.appendChild(h('p', { class: 'stat stat-full' }, h('strong', null, '🎉 Bingo: '), full.join(', ')));
    if (line.length) winners.appendChild(h('p', { class: 'stat stat-line' }, h('strong', null, '➖ Línea: '), line.join(', ')));

    const total = rows[0]?.ev.marked.length ?? 0;
    const visible = showAll ? rows : rows.slice(0, 8);
    showAllBtn.textContent = showAll ? 'Ver solo las 8 primeras' : `Ver todas las tarjetas (${rows.length})`;
    showAllBtn.hidden = rows.length <= 8;

    visible.forEach(({ card, ev }, i) => {
      const markedCount = ev.marked.filter(Boolean).length;
      const pct = total ? Math.round((markedCount / total) * 100) : 0;
      const status = ev.status === 'full' ? '🎉 Bingo' : ev.status === 'line' ? `➖ Línea ×${ev.completedLines.length}` : `Faltan ${ev.remaining}`;
      const row = h(
        'button',
        {
          class: `lb-row lb-${ev.status}`,
          type: 'button',
          title: 'Poner nombre al jugador',
          onClick: () => {
            const name = prompt(`Nombre del jugador de la tarjeta ${card.index + 1}:`, cardName(game, card.index));
            if (name === null) return;
            setCardName(game, card.index, name);
            renderWinners();
          },
        },
        h('span', { class: 'lb-rank' }, `${i + 1}.`),
        h('span', { class: 'lb-name' }, cardName(game, card.index) || `Tarjeta ${card.index + 1}`, cardName(game, card.index) ? h('span', { class: 'muted small' }, ` #${card.index + 1}`) : null),
        h('span', { class: 'lb-bar' }, h('span', { class: 'lb-bar-fill', style: { width: `${pct}%` } })),
        h('span', { class: 'lb-value' }, `${markedCount}/${total}`),
        h('span', { class: 'lb-status' }, status),
      );
      board.appendChild(row);
    });
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
    verifyResult.appendChild(h('p', { class: `verdict verdict-${ev.status}` }, `${cardTitle(game, index)} · ${cardLabel(game.config.seed, index)}: ${verdict}`));
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
    publish();
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
      if (err instanceof api.SpotifyApiError && err.status === 404) {
        toast('Spotify no encuentra el dispositivo elegido. Abre la app de Spotify en él, reproduce algo un segundo y vuelve a elegirlo en "Buscar dispositivos".', 'error');
        snippetPlayer = null;
        deviceStatus.textContent = 'Sin dispositivo de reproducción.';
        deviceStatus.className = 'muted';
        void refreshDevices();
      } else {
        toast(errorMessage(err), 'error');
      }
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
