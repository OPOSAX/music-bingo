#!/usr/bin/env node
/**
 * Prueba de carga del Concert Mode.
 *
 *   node scripts/concert-load-test/index.mjs --sim [--ready 100,1000,5000] [--cycles 50]
 *       Simula N participantes READY en memoria (ConcertRoom + handlers reales, sin red) y mide
 *       tiempo de alta, mensajes emitidos/seg, memoria y latencia de PREPARE→GO LIVE→END.
 *
 *   node scripts/concert-load-test/index.mjs --socket --url https://talk.example.com --room demo --ready 1000
 *       Abre N sockets reales contra un servidor B-Talk con Concert Mode. Requiere `socket.io-client`
 *       instalado (npm i -D socket.io-client) y un token de participante en CONCERT_TOKEN si el servidor lo exige.
 *
 * Requiere `npm run build` previo (importa los módulos compilados de public/js/concert).
 */

import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const sizes = String(value('ready', '100,1000,5000')).split(',').map(Number).filter((n) => n > 0);
const cycles = Number(value('cycles', 50));

const fmt = (n, d = 1) => n.toFixed(d);
const mb = () => process.memoryUsage().rss / 1024 / 1024;

async function simulate(n) {
  const { LocalConcertHub } = await import('../../public/js/concert/signaling.js');
  const { ParticipantClient } = await import('../../public/js/concert/participant-client.js');
  const { DjClient } = await import('../../public/js/concert/dj-client.js');
  const { ConcertMediaService, LocalMediaAdapter } = await import('../../public/js/concert/media-service.js');
  const { DEFAULT_CONFIG } = await import('../../public/js/concert/protocol.js');

  const fakeTrack = { kind: 'audio', stop() {} };
  const fakeMic = async () => ({ getAudioTracks: () => [fakeTrack], getTracks: () => [fakeTrack] });

  if (global.gc) global.gc();
  const memBefore = mb();
  const hub = new LocalConcertHub({ ...DEFAULT_CONFIG, concertMode: true, maxLiveMics: 2, maxPreparedMics: 2 }, 'load', { disconnectGraceMs: 1000 });
  let messages = 0;
  for (const key of ['toParticipant', 'toOperators']) {
    const emitter = hub.room.emitter;
    const orig = emitter[key].bind(emitter);
    emitter[key] = (...a) => {
      messages++;
      return orig(...a);
    };
  }
  const dj = new DjClient(hub.client('dj'), 'load');
  await dj.connect();

  const t0 = performance.now();
  const phones = [];
  for (let i = 0; i < n; i++) {
    const media = new ConcertMediaService(new LocalMediaAdapter((p) => hub.registerProducer(p)), fakeMic);
    const client = new ParticipantClient(hub.client('participant'), media, { participantId: `p${i}`, roomId: 'load', name: `Persona ${i}`, meta: { mesa: `Mesa ${i % 50}` } });
    await client.connect();
    await client.ready();
    phones.push(client);
  }
  const joinMs = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 10));
  const readyCount = hub.room.metrics().ready;
  const joinMessages = messages;

  // Ciclos PREPARE → GO LIVE → END sobre participantes distintos mientras los N siguen en READY.
  const latencies = [];
  messages = 0;
  const tc = performance.now();
  for (let c = 0; c < cycles; c++) {
    const pid = `p${(c * 7919) % n}`;
    const t1 = performance.now();
    await dj.prepare(pid);
    await new Promise((r) => setTimeout(r, 0));
    await dj.goLive(pid);
    await new Promise((r) => setTimeout(r, 0));
    await dj.end(pid);
    await new Promise((r) => setTimeout(r, 0));
    latencies.push(performance.now() - t1);
  }
  const cycleMs = performance.now() - tc;
  const cycleMessages = messages;

  // Paginación/búsqueda con la lista completa.
  const tl = performance.now();
  const page = await dj.list({ state: 'READY', query: 'Persona 12', limit: 50 });
  const listMs = performance.now() - tl;

  const memAfter = mb();
  latencies.sort((a, b) => a - b);
  const p = (q) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] ?? 0;
  console.log(`\n=== ${n} participantes READY (simulación en proceso) ===`);
  console.log(`alta+READY:        ${fmt(joinMs)} ms total · ${fmt(joinMs / n, 3)} ms/participante · ${readyCount} en READY`);
  console.log(`mensajes en alta:  ${joinMessages} (${fmt(joinMessages / (joinMs / 1000), 0)} msg/s)`);
  console.log(`${cycles} ciclos PREPARE→LIVE→END: ${fmt(cycleMs)} ms · latencia p50 ${fmt(p(0.5), 2)} ms · p95 ${fmt(p(0.95), 2)} ms · ${cycleMessages} mensajes (${fmt(cycleMessages / cycles, 1)} por ciclo)`);
  console.log(`lista (búsqueda+página 50 sobre ${page.total} resultados): ${fmt(listMs, 2)} ms`);
  console.log(`memoria RSS:       ${fmt(memBefore)} → ${fmt(memAfter)} MB (${fmt(((memAfter - memBefore) * 1024) / n, 1)} KB/participante)`);
  for (const ph of phones) await ph.disconnect();
  dj.disconnect();
}

async function socketTest(n) {
  let io;
  try {
    ({ io } = await import('socket.io-client'));
  } catch {
    console.error('Instala socket.io-client (npm i -D socket.io-client) para el modo --socket.');
    process.exit(1);
  }
  const { EVENTS } = await import('../../public/js/concert/protocol.js');
  const url = value('url', process.env.BTALK_URL);
  const roomId = value('room', 'demo');
  if (!url) {
    console.error('Falta --url o BTALK_URL');
    process.exit(1);
  }
  const auth = { roomId, ...(process.env.CONCERT_TOKEN ? { token: process.env.CONCERT_TOKEN } : {}) };
  const request = (socket, event, payload) => new Promise((resolve, reject) => socket.emit(event, payload, (r) => (r?.ok === false ? reject(new Error(r.message)) : resolve(r))));
  const sockets = [];
  const t0 = performance.now();
  let failures = 0;
  for (let i = 0; i < n; i++) {
    const socket = io(url, { transports: ['websocket'], auth });
    sockets.push(socket);
    try {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
      await request(socket, EVENTS.join, { roomId, participantId: `load-${process.pid}-${i}`, meta: { name: `Carga ${i}` } });
      await request(socket, EVENTS.ready, {});
    } catch (err) {
      failures++;
      if (failures < 5) console.error(`fallo ${i}: ${err.message}`);
    }
    if (i % 100 === 99) console.log(`${i + 1} sockets…`);
  }
  console.log(`\n=== ${n} sockets reales contra ${url} ===`);
  console.log(`alta+READY: ${fmt(performance.now() - t0)} ms · fallos ${failures}`);
  console.log('Manteniendo la conexión 30 s para observar métricas en el panel del DJ…');
  await new Promise((r) => setTimeout(r, 30_000));
  for (const s of sockets) s.disconnect();
}

if (flag('socket')) await socketTest(sizes[0] ?? 100);
else for (const n of sizes) await simulate(n);
