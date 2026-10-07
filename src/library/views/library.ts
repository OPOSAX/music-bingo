/**
 * Mi biblioteca (#/biblioteca): canciones subidas por animadores y administrador (compartidas, sin duplicados)
 * y listas propias de cada animador. Las listas se usan al elegir la música de un evento ("Mi biblioteca").
 */

import { button, clear, errorMessage, formatDuration, h, toast } from '../../dom.js';
import { navigate } from '../../router.js';
import { resolveServer, tokens } from '../../platform/api.js';
import { libraryApi, parseFileName, songUrl, uploadSong, type Playlist, type Song } from '../api.js';

let preview: HTMLAudioElement | null = null;

export async function renderLibrary(root: HTMLElement, params: URLSearchParams = new URLSearchParams()): Promise<void> {
  clear(root);
  preview?.pause();
  preview = null;
  await resolveServer(params.get('l'));
  if (!tokens.host() && !tokens.admin()) {
    navigate('/login?next=' + encodeURIComponent('/biblioteca'));
    return;
  }
  root.appendChild(
    h(
      'header',
      { class: 'page-header' },
      h('div', null, h('h1', null, '🎵 Mi biblioteca'), h('p', { class: 'muted' }, 'Canciones propias para jugar sin Spotify. Las canciones se comparten entre animadores; las listas son tuyas.')),
      h('div', { class: 'actions' }, button('← Mis eventos', () => navigate('/events'), 'btn btn-link')),
    ),
  );

  let songs: Song[] = [];
  let playlists: Playlist[] = [];
  let maxBytes = 30 * 1024 * 1024;
  let formats: string[] = ['mp3', 'm4a'];
  let current: Playlist | null = null;
  let filter = '';

  /* ---------------- Subida ---------------- */
  const fileInput = h('input', { type: 'file', accept: 'audio/*', multiple: true, hidden: true });
  const uploads = h('ul', { class: 'upload-list' });
  const drop = h(
    'div',
    { class: 'drop-zone' },
    h('p', null, h('strong', null, 'Arrastra aquí tus canciones'), ' o ', button('elige archivos', () => fileInput.click(), 'btn btn-sm')),
    h('p', { class: 'small muted' }, 'Formatos: mp3, m4a, aac, ogg, wav, flac. El nombre "Artista - Título.mp3" se reconoce solo; luego puedes corregirlo. Si el archivo ya existe en la biblioteca, se reutiliza.'),
  );
  drop.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (ev) => {
    ev.preventDefault();
    drop.classList.remove('over');
    void handleFiles([...(ev.dataTransfer?.files ?? [])]);
  });
  fileInput.addEventListener('change', () => {
    void handleFiles([...(fileInput.files ?? [])]);
    fileInput.value = '';
  });
  const uploadPanel = h('section', { class: 'panel' }, h('h2', null, '⬆️ Subir canciones'), drop, fileInput, uploads, h('p', { class: 'small muted' }, 'Sube solo música con la que tengas derecho a hacerlo.'));
  root.appendChild(uploadPanel);

  async function handleFiles(files: File[]): Promise<void> {
    const audio = files.filter((f) => /\.(mp3|m4a|aac|ogg|opus|wav|flac|webm)$/i.test(f.name));
    if (!audio.length) {
      toast('Ningún archivo de audio reconocido.', 'error');
      return;
    }
    for (const file of audio) {
      const row = h('li', { class: 'upload-row' }, h('span', { class: 'upload-name' }, file.name), h('span', { class: 'upload-state muted small' }, 'En cola…'));
      uploads.appendChild(row);
      const state = row.querySelector('.upload-state') as HTMLElement;
      if (file.size > maxBytes) {
        state.textContent = `Demasiado grande (máximo ${Math.round(maxBytes / 1024 / 1024)} MB)`;
        row.classList.add('failed');
        continue;
      }
      try {
        const meta = parseFileName(file.name);
        const result = await uploadSong(file, meta, (p) => {
          state.textContent = p.stage === 'hash' ? 'Calculando huella…' : p.stage === 'duration' ? 'Leyendo duración…' : p.stage === 'announce' ? 'Comprobando duplicados…' : p.stage === 'upload' ? `Subiendo ${p.percent ?? 0}%` : p.stage === 'duplicate' ? 'Ya estaba en la biblioteca' : 'Lista ✓';
        });
        state.textContent = result.duplicate ? `Ya estaba en la biblioteca como "${result.song.title}"` : 'Subida ✓';
        row.classList.add('done');
        if (current) {
          // Se añade directamente a la lista que se está editando.
          if (!current.songIds.includes(result.song.id)) await savePlaylist({ songIds: [...current.songIds, result.song.id] });
        }
      } catch (err) {
        state.textContent = errorMessage(err);
        row.classList.add('failed');
      }
    }
    await reload();
  }

  /* ---------------- Listas ---------------- */
  const playlistList = h('div', { class: 'playlist-chips' });
  const newName = h('input', { class: 'input', type: 'text', placeholder: 'Nombre de la lista nueva', maxLength: 80 });
  const newForm = h('form', { class: 'row' }, newName, h('button', { class: 'btn btn-sm', type: 'submit' }, '➕ Crear lista'));
  newForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = newName.value.trim();
    if (!name) return;
    void libraryApi
      .createPlaylist(name)
      .then(async (p) => {
        newName.value = '';
        await reload();
        current = playlists.find((x) => x.id === p.id) ?? null;
        draw();
      })
      .catch((err) => toast(errorMessage(err), 'error'));
  });
  const currentBox = h('div', { class: 'playlist-editor' });
  const playlistPanel = h('section', { class: 'panel' }, h('h2', null, '📋 Mis listas'), h('p', { class: 'small muted' }, 'Elige una lista para editarla: las canciones de la biblioteca se añaden con "＋". Después, al poner música a un evento, elige "Mi biblioteca".'), playlistList, newForm, currentBox);
  root.appendChild(playlistPanel);

  /* ---------------- Canciones ---------------- */
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Buscar por título, artista o álbum' });
  search.addEventListener('input', () => {
    filter = search.value.trim().toLowerCase();
    drawSongs();
  });
  const songList = h('div', { class: 'song-list' });
  const songCount = h('span', { class: 'badge' }, '0');
  root.appendChild(h('section', { class: 'panel' }, h('div', { class: 'row space' }, h('h2', null, '🎼 Canciones de la biblioteca ', songCount)), search, songList));

  async function reload(): Promise<void> {
    try {
      const [s, p] = await Promise.all([libraryApi.songs(), libraryApi.playlists()]);
      songs = s.songs;
      maxBytes = s.maxBytes;
      formats = s.formats;
      playlists = p.playlists;
      if (current) current = playlists.find((x) => x.id === current!.id) ?? null;
      draw();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  function draw(): void {
    clear(playlistList);
    if (!playlists.length) playlistList.appendChild(h('p', { class: 'muted small' }, 'Todavía no tienes listas. Crea una y añade canciones.'));
    for (const p of playlists) {
      playlistList.appendChild(button(`${p.name} (${p.songs.length})`, () => { current = current?.id === p.id ? null : p; draw(); }, `btn btn-sm ${current?.id === p.id ? 'btn-primary' : ''}`));
    }
    clear(currentBox);
    if (current) {
      const p = current;
      const name = h('input', { class: 'input', type: 'text', value: p.name, maxLength: 80 });
      name.addEventListener('change', () => void savePlaylist({ name: name.value.trim() || p.name }));
      const total = p.songs.reduce((n, s) => n + s.durationMs, 0);
      const rows = h('ol', { class: 'playlist-songs' });
      p.songs.forEach((s, i) => {
        rows.appendChild(
          h(
            'li',
            { class: 'playlist-song' },
            h('span', { class: 'song-title' }, h('strong', null, s.title), s.artist ? h('span', { class: 'muted' }, ` — ${s.artist}`) : null),
            h('span', { class: 'actions' },
              button('▲', () => void move(i, -1), 'btn btn-sm btn-icon'),
              button('▼', () => void move(i, 1), 'btn btn-sm btn-icon'),
              button('✕', () => void savePlaylist({ songIds: p.songIds.filter((id) => id !== s.id) }), 'btn btn-sm btn-icon'),
            ),
          ),
        );
      });
      currentBox.appendChild(
        h(
          'div',
          { class: 'playlist-current' },
          h('div', { class: 'row space' }, h('label', { class: 'field' }, h('span', null, 'Nombre'), name), h('span', { class: 'small muted' }, `${p.songs.length} canciones · ${formatDuration(total)}`)),
          p.songs.length ? rows : h('p', { class: 'muted small' }, 'Lista vacía: añade canciones desde la biblioteca con "＋" o sube archivos nuevos (se añaden solos).'),
          h('div', { class: 'actions' }, button('🗑 Borrar lista', () => { if (confirm(`¿Borrar la lista "${p.name}"? Las canciones siguen en la biblioteca.`)) void libraryApi.deletePlaylist(p.id).then(() => { current = null; return reload(); }).catch((err) => toast(errorMessage(err), 'error')); }, 'btn btn-sm btn-danger')),
        ),
      );
    }
    drawSongs();
  }

  async function move(i: number, delta: number): Promise<void> {
    if (!current) return;
    const ids = [...current.songIds];
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    await savePlaylist({ songIds: ids });
  }

  async function savePlaylist(patch: { name?: string; songIds?: string[] }): Promise<void> {
    if (!current) return;
    try {
      const updated = await libraryApi.updatePlaylist(current.id, patch);
      playlists = playlists.map((p) => (p.id === updated.id ? updated : p));
      current = updated;
      draw();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  function drawSongs(): void {
    clear(songList);
    const visible = songs.filter((s) => !filter || `${s.title} ${s.artist} ${s.album}`.toLowerCase().includes(filter));
    songCount.textContent = String(songs.length);
    if (!songs.length) {
      songList.appendChild(h('p', { class: 'muted small' }, 'La biblioteca está vacía: sube las primeras canciones arriba.'));
      return;
    }
    if (!visible.length) {
      songList.appendChild(h('p', { class: 'muted small' }, 'Ninguna canción coincide con la búsqueda.'));
      return;
    }
    const mine = tokens.admin() ? () => true : isMine;
    for (const s of visible) {
      const inList = current?.songIds.includes(s.id) ?? false;
      const row = h(
        'div',
        { class: `song-row${inList ? ' in-list' : ''}` },
        button('▶', () => play(s, row), 'btn btn-sm btn-icon play-btn'),
        h('div', { class: 'song-meta' }, h('strong', null, s.title), h('span', { class: 'muted small' }, [s.artist, s.album, s.durationMs ? formatDuration(s.durationMs) : null, `subida por ${s.uploadedByName}`].filter(Boolean).join(' · '))),
        h('div', { class: 'actions' },
          current ? button(inList ? '✓ En la lista' : '＋ Añadir', () => void savePlaylist({ songIds: inList ? current!.songIds.filter((id) => id !== s.id) : [...current!.songIds, s.id] }), `btn btn-sm ${inList ? '' : 'btn-primary'}`) : null,
          mine(s) ? button('✏️', () => edit(s), 'btn btn-sm btn-icon') : null,
          mine(s) ? button('🗑', () => { if (confirm(`¿Borrar "${s.title}" de la biblioteca?`)) void libraryApi.deleteSong(s.id).then(reload).catch((err) => toast(errorMessage(err), 'error')); }, 'btn btn-sm btn-icon') : null,
        ),
      );
      songList.appendChild(row);
    }
  }

  function isMine(s: Song): boolean {
    return myId !== null && s.uploadedBy === myId;
  }
  let myId: string | null = null;

  function edit(s: Song): void {
    const title = prompt('Título de la canción (es el que aparece en las tarjetas):', s.title);
    if (title === null) return;
    const artist = prompt('Artista:', s.artist);
    if (artist === null) return;
    void libraryApi.updateSong(s.id, { title: title.trim() || s.title, artist: artist.trim() }).then(reload).catch((err) => toast(errorMessage(err), 'error'));
  }

  function play(s: Song, row: HTMLElement): void {
    const btn = row.querySelector('.play-btn') as HTMLButtonElement;
    if (preview && preview.dataset.id === s.id && !preview.paused) {
      preview.pause();
      btn.textContent = '▶';
      return;
    }
    preview?.pause();
    document.querySelectorAll('.play-btn').forEach((b) => (b.textContent = '▶'));
    preview = new Audio(songUrl(s.id));
    preview.dataset.id = s.id;
    preview.currentTime = Math.max(0, (s.durationMs / 1000) * 0.3);
    preview.volume = 0.8;
    void preview.play().catch((err) => toast(`No se pudo reproducir: ${errorMessage(err)}`, 'error'));
    preview.onended = () => (btn.textContent = '▶');
    btn.textContent = '⏸';
  }

  // Identidad para saber qué canciones son mías (editar/borrar); el admin puede con todas.
  try {
    const { hostApi } = await import('../../platform/api.js');
    if (tokens.host()) myId = (await hostApi.me()).id;
  } catch {
    myId = null;
  }
  await reload();
  void formats;
}
