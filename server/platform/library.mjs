/**
 * Biblioteca propia de Bingo Hit: canciones subidas por animadores o el administrador (compartidas por todos,
 * sin duplicados gracias al hash del archivo) y listas por animador. Los archivos viven en MEDIA_DIR; los
 * metadatos en el almacén de la plataforma (colecciones `songs` y `playlists`).
 *
 * Flujo de subida: el cliente calcula el SHA-256 del archivo → POST /api/library/songs {hash, title, artist, …}
 * → si el hash ya existe se devuelve esa canción (`duplicate: true`); si no, se crea PENDING y el cliente envía
 * los bytes con PUT /api/library/songs/:id/file → READY.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { hashToken, identify, newId } from './auth.mjs';
import { PlatformError } from './service.mjs';

const now = () => new Date().toISOString();

const MIME_BY_EXT = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', webm: 'audio/webm' };
const ALLOWED_EXT = Object.keys(MIME_BY_EXT);

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

function clean(s, max) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function createLibraryApi(store, options = {}) {
  const mediaDir = path.resolve(options.mediaDir);
  const maxBytes = options.maxBytes ?? 30 * 1024 * 1024;
  const adminTokenHash = options.adminToken ? hashToken(options.adminToken) : null;
  const log = options.log ?? (() => undefined);
  mkdirSync(mediaDir, { recursive: true });

  const publicSong = (s) => ({ id: s.id, title: s.title, artist: s.artist, album: s.album, durationMs: s.durationMs, size: s.size, ext: s.ext, status: s.status, uploadedBy: s.uploadedBy, uploadedByName: s.uploadedByName, createdAt: s.createdAt });
  const fileOf = (song) => path.join(mediaDir, `${song.id}.${song.ext}`);
  const actor = (who) => {
    if (who.role === 'PLATFORM_ADMIN') return { id: 'admin', name: 'Administrador', admin: true };
    if (who.role === 'HOST') {
      if (who.user?.status !== 'ACTIVE') throw new PlatformError(403, 'suspended', 'Cuenta suspendida');
      return { id: who.id, name: who.user?.name ?? 'Animador', admin: false };
    }
    throw new PlatformError(who.role === 'ANON' ? 401 : 403, 'auth', 'Solo animadores y administradores usan la biblioteca');
  };
  const requireSong = (id) => {
    const song = store.get('songs', id);
    if (!song) throw new PlatformError(404, 'song', 'Canción no encontrada');
    return song;
  };
  const canEditSong = (a, song) => a.admin || song.uploadedBy === a.id;
  const ownPlaylist = (a, id) => {
    const p = store.get('playlists', id);
    if (!p) throw new PlatformError(404, 'playlist', 'Lista no encontrada');
    if (!a.admin && p.hostId !== a.id) throw new PlatformError(403, 'owner', 'Esta lista no es tuya');
    return p;
  };
  const publicPlaylist = (p) => {
    const songs = p.songIds.map((id) => store.get('songs', id)).filter((s) => s && s.status === 'READY').map(publicSong);
    return { id: p.id, hostId: p.hostId, name: p.name, songIds: p.songIds, songs, createdAt: p.createdAt, updatedAt: p.updatedAt };
  };

  /* ---------------- Canciones ---------------- */

  function createSong(who, body) {
    const a = actor(who);
    const hash = String(body.hash || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new PlatformError(400, 'hash', 'Falta el hash SHA-256 del archivo');
    const ext = String(body.ext || '').toLowerCase().replace(/^\./, '');
    if (!ALLOWED_EXT.includes(ext)) throw new PlatformError(400, 'format', `Formato no admitido (.${ext}). Usa ${ALLOWED_EXT.map((e) => '.' + e).join(', ')}`);
    const size = Number(body.size) || 0;
    if (size <= 0 || size > maxBytes) throw new PlatformError(413, 'size', `El archivo supera el máximo de ${Math.round(maxBytes / 1024 / 1024)} MB`);
    const existing = store.find('songs', (s) => s.hash === hash && s.status === 'READY');
    if (existing) return { song: publicSong(existing), duplicate: true };
    const pending = store.find('songs', (s) => s.hash === hash && s.status === 'PENDING' && s.uploadedBy === a.id);
    if (pending) return { song: publicSong(pending), duplicate: false };
    const title = clean(body.title, 120) || 'Sin título';
    const song = { id: newId('song'), hash, ext, size, title, artist: clean(body.artist, 120), album: clean(body.album, 120), durationMs: Math.max(0, Math.round(Number(body.durationMs) || 0)), status: 'PENDING', uploadedBy: a.id, uploadedByName: a.name, createdAt: now() };
    store.insert('songs', song);
    return { song: publicSong(song), duplicate: false };
  }

  function receiveFile(req, res, who, id) {
    const a = actor(who);
    const song = requireSong(id);
    if (!canEditSong(a, song)) throw new PlatformError(403, 'owner', 'Esta canción la subió otra persona');
    if (song.status === 'READY') throw new PlatformError(409, 'status', 'El archivo ya está subido');
    return new Promise((resolve, reject) => {
      const tmp = path.join(mediaDir, `${song.id}.upload`);
      const out = createWriteStream(tmp);
      const sha = createHash('sha256');
      let size = 0;
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        out.destroy();
        try {
          if (existsSync(tmp)) unlinkSync(tmp);
        } catch {
          /* ya borrado */
        }
        reject(err);
      };
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          return fail(new PlatformError(413, 'size', `El archivo supera el máximo de ${Math.round(maxBytes / 1024 / 1024)} MB`));
        }
        sha.update(chunk);
        out.write(chunk);
      });
      req.on('error', fail);
      req.on('end', () => {
        out.end(() => {
          if (failed) return;
          const hash = sha.digest('hex');
          if (hash !== song.hash) return fail(new PlatformError(400, 'hash', 'El archivo recibido no coincide con el hash anunciado'));
          const dup = store.find('songs', (s) => s.hash === hash && s.status === 'READY' && s.id !== song.id);
          if (dup) {
            // Alguien subió la misma canción mientras tanto: se reutiliza y se descarta la pendiente.
            unlinkSync(tmp);
            store.remove('songs', (s) => s.id === song.id);
            return resolve({ song: publicSong(dup), duplicate: true });
          }
          renameSync(tmp, fileOf(song));
          store.update('songs', song.id, { status: 'READY', size });
          store.audit(a.id, 'song.upload', { songId: song.id, title: song.title, size });
          log(`Canción subida: ${song.title} (${Math.round(size / 1024)} KB) por ${a.name}`);
          resolve({ song: publicSong(store.get('songs', song.id)), duplicate: false });
        });
      });
    }).then((r) => send(res, 200, r));
  }

  function serveFile(req, res, id) {
    const song = store.get('songs', id);
    if (!song || song.status !== 'READY') throw new PlatformError(404, 'song', 'Canción no encontrada');
    const file = fileOf(song);
    if (!existsSync(file)) throw new PlatformError(404, 'file', 'El archivo de la canción no está en el servidor');
    const total = statSync(file).size;
    const mime = MIME_BY_EXT[song.ext] || 'application/octet-stream';
    const range = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
    let start = 0;
    let end = total - 1;
    if (range) {
      if (range[1]) start = Number(range[1]);
      if (range[2]) end = Math.min(total - 1, Number(range[2]));
      if (!range[1] && range[2]) start = Math.max(0, total - Number(range[2]));
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
    }
    const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'private, max-age=86400' };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD') return res.end();
    createReadStream(file, { start, end }).pipe(res);
  }

  function updateSong(who, id, body) {
    const a = actor(who);
    const song = requireSong(id);
    if (!canEditSong(a, song)) throw new PlatformError(403, 'owner', 'Esta canción la subió otra persona');
    const patch = {};
    if (body.title !== undefined) patch.title = clean(body.title, 120) || song.title;
    if (body.artist !== undefined) patch.artist = clean(body.artist, 120);
    if (body.album !== undefined) patch.album = clean(body.album, 120);
    if (body.durationMs !== undefined && Number(body.durationMs) > 0) patch.durationMs = Math.round(Number(body.durationMs));
    return publicSong(store.update('songs', id, patch));
  }

  function deleteSong(who, id) {
    const a = actor(who);
    const song = requireSong(id);
    if (!canEditSong(a, song)) throw new PlatformError(403, 'owner', 'Esta canción la subió otra persona');
    const used = store.list('playlists', (p) => p.songIds.includes(id));
    if (used.length && !a.admin) throw new PlatformError(409, 'in-use', `La canción está en ${used.length} lista(s): quítala de ellas antes de borrarla`);
    for (const p of used) store.update('playlists', p.id, { songIds: p.songIds.filter((s) => s !== id) });
    try {
      if (existsSync(fileOf(song))) unlinkSync(fileOf(song));
    } catch {
      /* el archivo ya no estaba */
    }
    store.remove('songs', (s) => s.id === id);
    store.audit(a.id, 'song.delete', { songId: id, title: song.title });
    return { deleted: true, id };
  }

  /* ---------------- Listas ---------------- */

  function listPlaylists(who) {
    const a = actor(who);
    return store.list('playlists', (p) => a.admin || p.hostId === a.id).map(publicPlaylist);
  }

  function createPlaylist(who, body) {
    const a = actor(who);
    const name = clean(body.name, 80);
    if (!name) throw new PlatformError(400, 'name', 'La lista necesita un nombre');
    const p = { id: newId('pl'), hostId: a.id, name, songIds: validSongIds(body.songIds), createdAt: now(), updatedAt: now() };
    store.insert('playlists', p);
    return publicPlaylist(p);
  }

  function validSongIds(ids) {
    const seen = new Set();
    const out = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const s = store.get('songs', String(id));
      if (s && s.status === 'READY' && !seen.has(s.id)) {
        seen.add(s.id);
        out.push(s.id);
      }
    }
    return out;
  }

  function updatePlaylist(who, id, body) {
    const a = actor(who);
    const p = ownPlaylist(a, id);
    const patch = { updatedAt: now() };
    if (body.name !== undefined) patch.name = clean(body.name, 80) || p.name;
    if (body.songIds !== undefined) patch.songIds = validSongIds(body.songIds);
    return publicPlaylist(store.update('playlists', id, patch));
  }

  function deletePlaylist(who, id) {
    const a = actor(who);
    ownPlaylist(a, id);
    store.remove('playlists', (p) => p.id === id);
    return { deleted: true, id };
  }

  /* ---------------- Enrutado ---------------- */

  const SONG_FILE = /^\/api\/library\/songs\/([^/]+)\/file$/;
  const SONG = /^\/api\/library\/songs\/([^/]+)$/;
  const PLAYLIST = /^\/api\/library\/playlists\/([^/]+)$/;

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 256 * 1024) throw new PlatformError(413, 'body', 'Cuerpo demasiado grande');
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new PlatformError(400, 'json', 'JSON inválido');
    }
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    if (!p.startsWith('/api/library/')) return false;
    try {
      const auth = String(req.headers.authorization || '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const who = identify(store, token, adminTokenHash);
      let m;
      if ((m = p.match(SONG_FILE))) {
        if (req.method === 'GET' || req.method === 'HEAD') return serveFile(req, res, decodeURIComponent(m[1])), true;
        if (req.method === 'PUT') return await receiveFile(req, res, who, decodeURIComponent(m[1])), true;
      } else if (p === '/api/library/songs') {
        if (req.method === 'GET') {
          actor(who);
          const q = clean(url.searchParams.get('q'), 80).toLowerCase();
          const songs = store.list('songs', (s) => s.status === 'READY' && (!q || `${s.title} ${s.artist} ${s.album}`.toLowerCase().includes(q))).map(publicSong);
          songs.sort((a, b) => a.title.localeCompare(b.title, 'es', { sensitivity: 'base' }));
          return send(res, 200, { songs, maxBytes, formats: ALLOWED_EXT }), true;
        }
        if (req.method === 'POST') return send(res, 200, createSong(who, await readJson(req))), true;
      } else if ((m = p.match(SONG))) {
        const id = decodeURIComponent(m[1]);
        if (req.method === 'PATCH') return send(res, 200, updateSong(who, id, await readJson(req))), true;
        if (req.method === 'DELETE') return send(res, 200, deleteSong(who, id)), true;
      } else if (p === '/api/library/playlists') {
        if (req.method === 'GET') return send(res, 200, { playlists: listPlaylists(who) }), true;
        if (req.method === 'POST') return send(res, 200, createPlaylist(who, await readJson(req))), true;
      } else if ((m = p.match(PLAYLIST))) {
        const id = decodeURIComponent(m[1]);
        if (req.method === 'GET') return send(res, 200, publicPlaylist(ownPlaylist(actor(who), id))), true;
        if (req.method === 'PATCH') return send(res, 200, updatePlaylist(who, id, await readJson(req))), true;
        if (req.method === 'DELETE') return send(res, 200, deletePlaylist(who, id)), true;
      }
      send(res, 404, { error: 'not-found', message: 'Ruta no encontrada' });
    } catch (err) {
      const status = err instanceof PlatformError ? err.status : 500;
      if (status === 500) console.error('Library API error', err);
      if (!res.headersSent) send(res, status, { error: err.code ?? 'internal', message: err.message });
      else res.end();
    }
    return true;
  };
}
