/** Configuración de una partida nueva: elegir lista y opciones, generar tarjetas. */

import type { GameConfig, GridSize, StartMode, Track } from '../bingo.js';
import type { AutoMark } from '../sync.js';
import { cellCount, recommendedPoolSize, validateConfig } from '../bingo.js';
import { button, clear, errorMessage, h, toast } from '../dom.js';
import { randomCode } from '../rng.js';
import { DECADES, GENRES, buildQueries, describeOptions, pickTracks, type HitsOptions, type Language } from '../hits.js';
import { navigate } from '../router.js';
import * as api from '../spotify-api.js';
import { createGame, loadGame, saveGame } from '../store.js';

interface Source {
  kind: 'playlist' | 'saved' | 'generated';
  id: string;
  name: string;
  trackCount: number | null;
  /** Canciones ya cargadas (listas generadas). */
  tracks?: Track[];
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

  /* ---- Generador de éxitos ---- */
  const langSelect = h('select', { class: 'input' }, h('option', { value: 'es' }, 'Español'), h('option', { value: 'en' }, 'Inglés'), h('option', { value: 'both' }, 'Español e inglés'));
  const decadeBoxes = DECADES.map((d) => ({ id: d.id, box: h('input', { type: 'checkbox', checked: d.id === '80' || d.id === '90' }), label: d.label }));
  const genreBoxes = GENRES.map((g) => ({ id: g.id, box: h('input', { type: 'checkbox', checked: g.id === 'pop' || g.id === 'rock' }), label: g.label }));
  const countInput = h('input', { class: 'input', type: 'number', min: '10', max: '300', value: '60' });
  const saveToSpotify = h('input', { type: 'checkbox', checked: true });
  const genStatus = h('p', { class: 'muted small' });
  const genResult = h('div', { class: 'gen-result' });
  const genBtn = button('🔎 Buscar éxitos', () => void generate(), 'btn btn-primary');
  const checks = (items: { id: string; box: HTMLInputElement; label: string }[]) => h('div', { class: 'check-grid' }, ...items.map((i) => h('label', { class: 'field field-check' }, i.box, h('span', null, i.label))));
  const generator = h(
    'details',
    { class: 'generator' },
    h('summary', null, '✨ Generar una lista de éxitos (por idioma, época y género)'),
    h('div', { class: 'fields' }, h('label', { class: 'field' }, h('span', null, 'Idioma'), langSelect), h('label', { class: 'field' }, h('span', null, 'Número de canciones'), countInput), h('label', { class: 'field field-check' }, saveToSpotify, h('span', null, 'Guardar la lista en mi Spotify'))),
    h('p', { class: 'muted small' }, 'Épocas'),
    checks(decadeBoxes),
    h('p', { class: 'muted small' }, 'Géneros'),
    checks(genreBoxes),
    h('div', { class: 'actions' }, genBtn),
    genStatus,
    genResult,
  );

  async function generate(): Promise<void> {
    const options: HitsOptions = {
      language: langSelect.value as Language,
      decades: decadeBoxes.filter((d) => d.box.checked).map((d) => d.id),
      genres: genreBoxes.filter((g) => g.box.checked).map((g) => g.id),
      count: Math.max(10, Math.min(300, Number(countInput.value) || 60)),
    };
    const queries = buildQueries(options);
    genBtn.disabled = true;
    clear(genResult);
    genStatus.textContent = `Buscando en Spotify (${queries.length} búsquedas)…`;
    try {
      const perQuery = Math.min(60, Math.max(10, Math.ceil((options.count * 1.5) / Math.max(1, queries.length))));
      const results: Track[][] = [];
      let failures = 0;
      for (const [i, q] of queries.entries()) {
        genStatus.textContent = `Buscando ${q.label || q.q}… (${i + 1}/${queries.length})`;
        try {
          results.push(await api.searchTracksUpTo(q.q, perQuery, q.market));
        } catch (err) {
          failures++;
          if (failures === queries.length) throw err;
        }
      }
      const tracks = pickTracks(results, options.count);
      if (tracks.length === 0) {
        genStatus.textContent = 'No se encontraron canciones con esas opciones. Prueba con otros géneros o épocas.';
        return;
      }
      const name = describeOptions(options);
      genStatus.textContent = `${tracks.length} canciones encontradas${tracks.length < options.count ? ` (se pedían ${options.count}: amplía épocas o géneros para más)` : ''}.`;
      const sample = tracks.slice(0, 8).map((t) => `${t.name} — ${t.artists}`).join(' · ');
      genResult.appendChild(h('p', { class: 'small' }, sample, tracks.length > 8 ? ' · …' : ''));
      const useList = (andCreate: boolean) => {
        select({ kind: 'generated', id: `generated-${Date.now()}`, name, trackCount: tracks.length, tracks });
        generator.open = false;
        if (saveToSpotify.checked) {
          api
            .createPlaylist(name, 'Creada por Bingo musical', tracks)
            .then(() => toast(`Lista "${name}" guardada en tu Spotify`, 'success'))
            .catch((err) => toast(`No se pudo guardar la lista en Spotify: ${errorMessage(err)}. Si acabas de actualizar la app, cierra sesión y vuelve a conectar para conceder el permiso.`, 'error'));
        }
        if (andCreate) void create();
      };
      genResult.appendChild(
        h(
          'div',
          { class: 'actions' },
          button(`▶ Crear partida con esta lista (${tracks.length} canciones)`, () => useList(true), 'btn btn-primary'),
          button('Solo seleccionar', () => useList(false), 'btn btn-link'),
        ),
      );
    } catch (err) {
      genStatus.textContent = `No se pudo buscar en Spotify: ${errorMessage(err)}`;
    } finally {
      genBtn.disabled = false;
    }
  }

  const step1 = h(
    'section',
    { class: 'panel' },
    h('h2', null, '1. Elige la lista de canciones'),
    selectedLabel,
    generator,
    h('p', { class: 'muted small' }, 'O pega una URL de lista:'),
    urlForm,
    h('p', { class: 'muted small' }, 'O elige una de tus listas:'),
    playlistGrid,
  );
  root.appendChild(step1);

  const select = (source: Source) => {
    selected = source;
    clear(selectedLabel);
    selectedLabel.className = 'selected-source';
    selectedLabel.appendChild(h('strong', null, `✅ Lista seleccionada: ${source.name}`));
    if (source.trackCount !== null) selectedLabel.appendChild(h('span', { class: 'muted' }, ` · ${source.trackCount} canciones`));
    playlistGrid.querySelectorAll('.playlist-item').forEach((el) => el.classList.toggle('selected', (el as HTMLElement).dataset.id === source.id));
    updateHint();
    toast(`Lista seleccionada: ${source.name}`, 'success');
    optionsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  Promise.all([api.getMyPlaylists(), api.getMe().catch(() => null)])
    .then(([all, me]) => {
      // Spotify (modo desarrollo) solo deja leer listas propias o colaborativas: las demás se muestran al final, marcadas.
      const usable = (p: api.PlaylistSummary) => !me || p.ownerId === me.id || p.collaborative;
      const playlists = [...all.filter(usable), ...all.filter((p) => !usable(p))];
      clear(playlistGrid);
      playlistGrid.appendChild(
        h('button', { class: 'playlist-item', type: 'button', dataset: { id: 'saved' }, onClick: () => select({ kind: 'saved', id: 'saved', name: 'Canciones que te gustan', trackCount: null }) }, h('div', { class: 'playlist-cover placeholder' }, '♥'), h('div', { class: 'playlist-meta' }, h('strong', null, 'Canciones que te gustan'), h('span', { class: 'muted small' }, 'Tu biblioteca'))),
      );
      for (const p of playlists) {
        const ok = usable(p);
        const meta = [p.owner, p.trackCount !== null ? `${p.trackCount} canciones` : null, ok ? null : 'de otro usuario: no disponible'].filter(Boolean).join(' · ');
        playlistGrid.appendChild(
          h(
            'button',
            { class: `playlist-item${ok ? '' : ' unavailable'}`, type: 'button', dataset: { id: p.id }, onClick: () => select({ kind: 'playlist', id: p.id, name: p.name, trackCount: p.trackCount }) },
            p.image ? h('img', { class: 'playlist-cover', src: p.image, alt: '', loading: 'lazy' }) : h('div', { class: 'playlist-cover placeholder' }, '♪'),
            h('div', { class: 'playlist-meta' }, h('strong', null, p.name), h('span', { class: 'muted small' }, meta)),
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
  const autoMark = h('select', { class: 'input' }, h('option', { value: 'played' }, 'Se marcan solas cuando suena la canción'), h('option', { value: 'revealed' }, 'Se marcan solas cuando revelas el título'), h('option', { value: 'off' }, 'No: cada jugador marca a mano'));
  autoMark.value = previous?.autoMark ?? 'played';
  const lyrics = h('input', { type: 'checkbox', checked: previous?.lyrics !== false });
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const continuous = h('input', { type: 'checkbox', checked: previous?.continuous ?? isMobile });
  const hint = h('p', { class: 'muted small' });

  const updateHint = () => {
    const size = Number(gridSelect.value) as GridSize;
    const needed = cellCount(size, freeCenter.checked);
    const recommended = recommendedPoolSize(size, freeCenter.checked);
    const count = selected?.trackCount ?? null;
    hint.textContent = `Cada tarjeta tiene ${needed} canciones. Se recomiendan al menos ${recommended} en la lista` + (count !== null ? ` (la seleccionada tiene ${count}).` : '.') + ' Si la lista tiene menos canciones que casillas, las casillas sobrantes quedan libres.';
    freeCenter.disabled = size % 2 === 0;
  };
  gridSelect.addEventListener('change', updateHint);
  freeCenter.addEventListener('change', updateHint);
  updateHint();

  const field = (label: string, control: HTMLElement) => h('label', { class: 'field' }, h('span', null, label), control);
  const optionsPanel = h(
      'section',
      { class: 'panel' },
      h('h2', null, '2. Opciones'),
      h('div', { class: 'fields' }, field('Tamaño de la tarjeta', gridSelect), h('label', { class: 'field field-check' }, freeCenter, h('span', null, 'Casilla central libre')), field('Número de tarjetas', cardCount), field('Segundos por canción', snippet), field('Por dónde empieza el fragmento', startMode), field('Tarjetas escaneadas (móvil)', autoMark), h('label', { class: 'field field-check' }, lyrics, h('span', null, 'Mostrar la letra (karaoke)')), h('label', { class: 'field field-check' }, continuous, h('span', null, 'Reproducción continua: la canción sigue hasta la siguiente (recomendado si suena en un móvil)'))),
      hint,
  );
  root.appendChild(optionsPanel);

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
      const tracks: Track[] = selected.kind === 'generated' ? (selected.tracks ?? []) : selected.kind === 'saved' ? await api.getSavedTracks(onProgress) : await api.getPlaylistTracks(selected.id, onProgress);
      const config: GameConfig = {
        seed: randomCode(6),
        gridSize: Number(gridSelect.value) as GridSize,
        freeCenter: freeCenter.checked,
        cardCount: Number(cardCount.value),
        snippetSeconds: Number(snippet.value),
        startMode: startMode.value as StartMode,
        autoMark: autoMark.value as AutoMark,
        lyrics: lyrics.checked,
        continuous: continuous.checked,
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
