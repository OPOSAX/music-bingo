#!/usr/bin/env node
// Servidor estático mínimo para desarrollo, sin dependencias.
// Sirve ./public en http://127.0.0.1:8888 (Spotify exige una IP de loopback
// para redirect URIs http://, "localhost" no está permitido).
// Con --watch, además lanza `tsc --watch` para recompilar src/ al vuelo.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'public');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8888);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 500, 'Error interno');
    send(res, 200, data, type);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) return send(res, 403, 'Prohibido');

  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isFile()) return serveFile(res, filePath);
    // SPA fallback: cualquier ruta desconocida devuelve index.html
    if (path.extname(pathname) === '' || pathname === '/index.html') {
      return serveFile(res, path.join(ROOT, 'index.html'));
    }
    send(res, 404, 'No encontrado');
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Bingo musical: http://${HOST}:${PORT}/`);
  console.log(`Redirect URI para el panel de Spotify: http://${HOST}:${PORT}/`);
});

if (process.argv.includes('--watch')) {
  const tscBin = path.join(__dirname, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  const cmd = fs.existsSync(tscBin) ? tscBin : 'tsc';
  const child = spawn(cmd, ['-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'], {
    cwd: __dirname,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('exit', (code) => {
    if (code) console.error(`tsc terminó con código ${code}`);
  });
  process.on('SIGINT', () => {
    child.kill();
    process.exit(0);
  });
}
