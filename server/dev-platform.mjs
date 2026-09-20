/**
 * Servidor ligero de desarrollo: sirve la app estática y la API de la plataforma sin mediasoup ni Socket.IO
 * (útil para probar eventos, tarjetas y pagos simulados sin dependencias). `node server/dev-platform.mjs`.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPlatformApi } from './platform/api.mjs';
import { PlatformService } from './platform/service.mjs';
import { Store } from './platform/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3011);
const publicDir = path.resolve(process.env.STATIC_DIR || path.join(here, '..', 'public'));
const adminToken = process.env.PLATFORM_ADMIN_TOKEN || 'admin-dev';
const store = new Store(process.env.PLATFORM_DATA_FILE === 'memory' ? null : path.resolve(process.env.PLATFORM_DATA_FILE || path.join(here, 'data', 'platform-dev.json')));
const publicUrl = process.env.PUBLIC_URL || `http://127.0.0.1:${port}`;
const service = new PlatformService(store, { env: process.env, appUrl: `${publicUrl}/`, apiUrl: publicUrl, log: (m) => console.log(m) });
const api = createPlatformApi(service, { adminToken, adminUser: process.env.PLATFORM_ADMIN_USER || 'admin', adminPassword: process.env.PLATFORM_ADMIN_PASSWORD || 'admin-dev', mockPayments: true });
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json' };

const server = createServer(async (req, res) => {
  if (await api(req, res)) return;
  const url = new URL(req.url, 'http://local');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', concert: true, live: false, platform: true, dev: true }));
    return;
  }
  let file = path.join(publicDir, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(publicDir)) return void (res.writeHead(403), res.end());
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(publicDir, 'index.html');
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
});
server.listen(port, '127.0.0.1', () => console.log(`dev-platform en http://127.0.0.1:${port}/  (admin token: ${adminToken})`));
