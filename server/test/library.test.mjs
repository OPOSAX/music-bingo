/** Pruebas de la biblioteca propia: subida con hash, duplicados, descarga con Range, permisos y listas. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createPlatformApi } from '../platform/api.mjs';
import { createLibraryApi } from '../platform/library.mjs';
import { PlatformService } from '../platform/service.mjs';
import { Store } from '../platform/store.mjs';

async function boot() {
  const store = new Store(null);
  const service = new PlatformService(store, { env: {}, appUrl: 'http://app/', apiUrl: 'http://api' });
  const platform = createPlatformApi(service, { adminToken: 'admin-token' });
  const mediaDir = mkdtempSync(path.join(tmpdir(), 'bingo-media-'));
  const library = createLibraryApi(store, { mediaDir, maxBytes: 1024 * 1024, adminToken: 'admin-token' });
  const server = createServer((req, res) => {
    library(req, res)
      .then((h) => (h ? true : platform(req, res)))
      .then((h) => {
        if (!h) {
          res.writeHead(404);
          res.end();
        }
      });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, { token, body, raw, headers } = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(headers ?? {}), Connection: 'close' }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers, text };
  };
  const close = () => {
    server.closeAllConnections();
    server.close();
    rmSync(mediaDir, { recursive: true, force: true });
  };
  return { store, call, close, mediaDir };
}

const bytes = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256));
const sha = (b) => createHash('sha256').update(b).digest('hex');

test('biblioteca: subir, deduplicar, descargar con Range, editar, listas y permisos', async () => {
  const { store, call, close, mediaDir } = await boot();
  try {
    const { data: h1 } = await call('POST', '/api/admin/hosts', { token: 'admin-token', body: { name: 'Ana', username: 'ana', password: 'secreta1' } });
    const { data: h2 } = await call('POST', '/api/admin/hosts', { token: 'admin-token', body: { name: 'Beto', username: 'beto', password: 'secreta1' } });
    const file = bytes(5000, 7);
    // Un jugador o anónimo no puede
    assert.equal((await call('GET', '/api/library/songs', {})).status, 401);
    // Anuncio + subida
    const meta = { hash: sha(file), ext: 'mp3', size: file.length, title: '  Mi canción  ', artist: 'Artista', durationMs: 123456 };
    const created = await call('POST', '/api/library/songs', { token: h1.token, body: meta });
    assert.equal(created.status, 200);
    assert.equal(created.data.duplicate, false);
    assert.equal(created.data.song.status, 'PENDING');
    assert.equal(created.data.song.title, 'Mi canción');
    const id = created.data.song.id;
    // Hasta que llega el archivo no se sirve ni aparece en la lista
    assert.equal((await call('GET', `/api/library/songs/${id}/file`, {})).status, 404);
    assert.equal((await call('GET', '/api/library/songs', { token: h1.token })).data.songs.length, 0);
    // Hash incorrecto: se rechaza
    const bad = await call('PUT', `/api/library/songs/${id}/file`, { token: h1.token, raw: bytes(5000, 9), headers: { 'Content-Type': 'audio/mpeg' } });
    assert.equal(bad.status, 400);
    // Otro animador no puede subir el archivo de esta canción
    assert.equal((await call('PUT', `/api/library/songs/${id}/file`, { token: h2.token, raw: file, headers: { 'Content-Type': 'audio/mpeg' } })).status, 403);
    const up = await call('PUT', `/api/library/songs/${id}/file`, { token: h1.token, raw: file, headers: { 'Content-Type': 'audio/mpeg' } });
    assert.equal(up.status, 200, up.text);
    assert.equal(up.data.song.status, 'READY');
    assert.ok(existsSync(path.join(mediaDir, `${id}.mp3`)));
    // Compartida: el otro animador la ve; el mismo archivo no se sube dos veces
    assert.equal((await call('GET', '/api/library/songs', { token: h2.token })).data.songs.length, 1);
    const again = await call('POST', '/api/library/songs', { token: h2.token, body: { ...meta, title: 'Otro nombre' } });
    assert.equal(again.data.duplicate, true);
    assert.equal(again.data.song.id, id);
    // Descarga completa y parcial (Range) sin token: el id es la única llave
    const full = await call('GET', `/api/library/songs/${id}/file`, {});
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'audio/mpeg');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(Buffer.from(full.text, 'latin1').length > 0, true);
    const part = await call('GET', `/api/library/songs/${id}/file`, { headers: { Range: 'bytes=100-199' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 100-199/${file.length}`);
    assert.equal(part.headers.get('content-length'), '100');
    assert.equal((await call('GET', `/api/library/songs/${id}/file`, { headers: { Range: 'bytes=99999-' } })).status, 416);
    // Editar: solo quien la subió o el admin
    assert.equal((await call('PATCH', `/api/library/songs/${id}`, { token: h2.token, body: { title: 'X' } })).status, 403);
    assert.equal((await call('PATCH', `/api/library/songs/${id}`, { token: 'admin-token', body: { title: 'Editada' } })).data.title, 'Editada');
    // Listas por animador
    const pl = await call('POST', '/api/library/playlists', { token: h1.token, body: { name: 'Fiesta', songIds: [id, 'no-existe', id] } });
    assert.equal(pl.status, 200);
    assert.deepEqual(pl.data.songIds, [id], 'ids inválidos y repetidos fuera');
    assert.equal(pl.data.songs[0].title, 'Editada');
    assert.equal((await call('GET', '/api/library/playlists', { token: h2.token })).data.playlists.length, 0, 'las listas son de cada animador');
    assert.equal((await call('GET', '/api/library/playlists', { token: 'admin-token' })).data.playlists.length, 1, 'el admin las ve todas');
    assert.equal((await call('PATCH', `/api/library/playlists/${pl.data.id}`, { token: h2.token, body: { name: 'Mía' } })).status, 403);
    // Borrar canción en uso: el animador no puede; el admin sí y se quita de las listas
    assert.equal((await call('DELETE', `/api/library/songs/${id}`, { token: h1.token })).data.error, 'in-use');
    assert.equal((await call('DELETE', `/api/library/songs/${id}`, { token: 'admin-token' })).status, 200);
    assert.equal(store.get('playlists', pl.data.id).songIds.length, 0);
    assert.ok(!existsSync(path.join(mediaDir, `${id}.mp3`)));
    // Límite de tamaño y formato
    assert.equal((await call('POST', '/api/library/songs', { token: h1.token, body: { ...meta, size: 2 * 1024 * 1024 } })).status, 413);
    assert.equal((await call('POST', '/api/library/songs', { token: h1.token, body: { ...meta, ext: 'exe' } })).status, 400);
  } finally {
    close();
  }
});
