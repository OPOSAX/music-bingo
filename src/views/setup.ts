/** Configuración de una partida nueva: elegir lista y opciones, generar tarjetas. */

import type { GameConfig, GridSize, StartMode, Track } from '../bingo.js';
import { cellCount, recommendedPoolSize, validateConfig } from '../bingo.js';
import { button, clear, errorMessage, h, toast } from '../dom.js';
import { randomCode } from '../rng.js';
import { navigate } from '../router.js';
import * as api from '../spotify-api.js';
import { createGame, loadGame, saveGame } from '../store.js';

interface Source {
  kind: 'playlist' | 'saved';
  id: string;
  name: string;
  trackCount: number;
}

export async function renderSetup(root: HTMLElement): Promise<void> {
  clear(root);
  let selected: Source | null = null;

  const header = h('header', { class: 'page-header' }, h('h1', null, 'Nueva partida'), button('← Inicio', () => navigate('/'), 'btn btn-link'));
  root.appendChild(header);

  /* ---- Paso 1: lista ---- */
  const selectedLabel = h('p', { class: 'muted' }, 'Ninguna lista seleccionada.');
  const playlistGrid = h('div', { class: 'playlist-grid' }, h('p', { class: 'muted' }, 'Cargando tus listas…'));
  const urlInput = h('input', { class: 'input', type: 'text', placeholder: 'Pega una URL de lista de Spotify (open.spotify.com/playlist/…)' });
  const urlForm = h('form', { class: 'row' }, urlInput, h('button', { class: 'btn', type: 'submit' }, 'Usar esta lista'));

  const step1 = h(
    'section',
    { class: 'panel' },
    h('h2', null, '1. Elige la lista de canciones'),
    urlForm,
    h('p', { class: 'muted small' }, 'O elige una de tus listas:'),
    playlistGrid,
    selectedLabel,
  );
  root.appendChild(step1);

  const select = (source: Source) => {
    selected = source;
    clear(selectedLabel);
    selectedLabel.appendChild(h('strong', null, `Lista seleccionada: ${source.name}`));
    selectedLabel.appendChild(h('span', { class: 'muted' }, ` · ${source.trackCount} canciones`));
    playlistGrid.querySelectorAll('.playlist-item').forEach((el) => el.classList.toggle('selected', (el as HTMLElement).dataset.id === source.id));
    updateHint();
  };

  urlForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const id = api.parsePlaylistInput(urlInput.value);
    if (!id) {
      toast('No reconozco esa URL de lista.', 'error');
      return;
    }
    try {
      const summary = await api.getPlaylistSummary(id);
      select({ kind: 'playlist', id: summary.id, name: summary.name, trackCount: summary.trackCount });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  api
    .getMyPlaylists()
    .then((playlists) => {
      clear(playlistGrid);
      playlistGrid.appendChild(
        h('button', { class: 'playlist-item', type: 'button', dataset: { id: 'saved' }, onClick: () => select({ kind: 'saved', id: 'saved', name: 'Canciones que te gustan', trackCount: 0 }) }, h('div', { class: 'playlist-cover placeholder' }, '♥'), h('div', { class: 'playlist-meta' }, h('strong', null, 'Canciones que te gustan'), h('span', { class: 'muted small' }, 'Tu biblioteca'))),
      );
      for (const p of playlists) {
        playlistGrid.appendChild(
          h(
            'button',
            { class: 'playlist-item', type: 'button', dataset: { id: p.id }, onClick: () => select({ kind: 'playlist', id: p.id, name: p.name, trackCount: p.trackCount }) },
            p.image ? h('img', { class: 'playlist-cover', src: p.image, alt: '', loading: 'lazy' }) : h('div', { class: 'playlist-cover placeholder' }, '♪'),
            h('div', { class: 'playlist-meta' }, h('strong', null, p.name), h('span', { class: 'muted small' }, `${p.owner} · ${p.trackCount} canciones`)),
          ),
        );
      }
      if (playlists.length === 0) playlistGrid.appendChild(h('p', { class: 'muted' }, 'No tienes listas. Pega una URL arriba.'));
    })
    .catch((err) => {
      clear(playlistGrid);
      playlistGrid.appendChild(h('p', { class: 'alert alert-error' }, errorMessage(err)));
    });

  /* ---- Paso 2: opciones ---- */
  const previous = loadGame()?.config;
  const gridSelect = h('select', { class: 'input' }, h('option', { value: '3' }, '3 × 3 (9 canciones, rápido)'), h('option', { value: '4' }, '4 × 4 (16 canciones)'), h('option', { value: '5' }, '5 × 5 (25 canciones, clásico)'));
  gridSelect.value = String(previous?.gridSize ?? 5);
  const freeCenter = h('input', { type: 'checkbox', checked: previous?.freeCenter ?? true });
  const cardCount = h('input', { class: 'input', type: 'number', min: '1', max: '500', value: String(previous?.cardCount ?? 20) });
  const snippet = h('input', { class: 'input', type: 'number', min: '3', max: '120', value: String(previous?.snippetSeconds ?? 20) });
  const startMode = h('select', { class: 'input' }, h('option', { value: 'random' }, 'Punto aleatorio de la canción'), h('option', { value: 'middle' }, 'Hacia la mitad (suele ser el estribillo)'), h('option', { value: 'start' }, 'Desde el principio'));
  startMode.value = previous?.startMode ?? 'random';
  const hint = h('p', { class: 'muted small' });

  const updateHint = () => {
    const size = Number(gridSelect.value) as GridSize;
    const needed = cellCount(size, freeCenter.checked);
    const recommended = recommendedPoolSize(size, freeCenter.checked);
    const count = selected?.trackCount ?? 0;
    hint.textContent = `Cada tarjeta tiene ${needed} canciones. Se recomiendan al menos ${recommended} canciones en la lista` + (selected && count ? ` (la seleccionada tiene ${count}).` : '.');
    freeCenter.disabled = size % 2 === 0;
  };
  gridSelect.addEventListener('change', updateHint);
  freeCenter.addEventListener('change', updateHint);
  updateHint();

  const field = (label: string, control: HTMLElement) => h('label', { class: 'field' }, h('span', null, label), control);
  root.appendChild(
    h(
      'section',
      { class: 'panel' },
      h('h2', null, '2. Opciones'),
      h('div', { class: 'fields' }, field('Tamaño de la tarjeta', gridSelect), h('label', { class: 'field field-check' }, freeCenter, h('span', null, 'Casilla central libre')), field('Número de tarjetas', cardCount), field('Segundos por canción', snippet), field('Por dónde empieza el fragmento', startMode)),
      hint,
    ),
  );

  /* ---- Paso 3: crear ---- */
  const status = h('p', { class: 'muted' });
  const createBtn = button('Crear partida y generar tarjetas', () => void create(), 'btn btn-primary btn-lg');
  root.appendChild(h('section', { class: 'panel' }, h('h2', null, '3. ¡A jugar!'), createBtn, status));

  async function create(): Promise<void> {
    if (!selected) {
      toast('Elige primero una lista.', 'error');
      return;
    }
    if (loadGame() && !confirm('Ya hay una partida guardada. Al crear otra, sus tarjetas dejarán de ser válidas. ¿Continuar?')) return;
    createBtn.disabled = true;
    status.textContent = 'Cargando canciones…';
    try {
      const onProgress = (loaded: number, total: number) => {
        status.textContent = `Cargando canciones… ${loaded}/${total}`;
      };
      const tracks: Track[] = selected.kind === 'saved' ? await api.getSavedTracks(onProgress) : await api.getPlaylistTracks(selected.id, onProgress);
      const config: GameConfig = {
        seed: randomCode(6),
        gridSize: Number(gridSelect.value) as GridSize,
        freeCenter: freeCenter.checked,
        cardCount: Number(cardCount.value),
        snippetSeconds: Number(snippet.value),
        startMode: startMode.value as StartMode,
      };
      const errors = validateConfig(config, tracks.length);
      if (errors.length) {
        status.textContent = '';
        errors.forEach((e) => toast(e, 'error'));
        return;
      }
      saveGame(createGame(config, selected.name, tracks));
      toast(`Partida ${config.seed} creada con ${tracks.length} canciones.`, 'success');
      navigate('/host');
    } catch (err) {
      status.textContent = '';
      toast(errorMessage(err), 'error');
    } finally {
      createBtn.disabled = false;
    }
  }
}
