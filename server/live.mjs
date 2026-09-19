/**
 * Bingo Hit Live: un animador publica cámara/micrófono/audio del evento (1 publisher) y cientos o
 * miles de jugadores lo reciben (N viewers) a través del SFU mediasoup de B-Talk. El plano de juego
 * (estado de la partida, tarjetas, bingos, ganador, reacciones) viaja por Socket.IO, nunca por el vídeo.
 */

import { createHmac } from 'node:crypto';

import { evaluateCard, generateCard } from '../public/js/bingo.js';
import { LIVE_EVENTS as E, REACTIONS } from '../public/js/live/protocol.js';

const REACTION_MIN_MS = 500;
const BINGO_MIN_MS = 3000;
const CLAIM_MIN_MS = 800;
const REACTION_FLUSH_MS = 400;
const STATS_MS = 5000;
const MAX_MESSAGE_BYTES = 64 * 1024;

const ok = (ack, data = {}) => typeof ack === 'function' && ack({ ok: true, ...data });
const fail = (ack, code, message) => typeof ack === 'function' && ack({ ok: false, code, message });

/** Servidores ICE para los clientes: STUN/TURN desde variables de entorno, con credenciales temporales (coturn REST) si hay TURN_SECRET. */
export function iceServersFromEnv(env, ttlSeconds = 3600) {
  const servers = [];
  if (env.STUN_SERVER_URL) servers.push({ urls: env.STUN_SERVER_URL });
  if (env.TURN_SERVER_URL) {
    const entry = { urls: env.TURN_SERVER_URL.split(',').map((u) => u.trim()).filter(Boolean) };
    if (env.TURN_SECRET) {
      const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:${env.TURN_USERNAME || 'bingo'}`;
      entry.username = username;
      entry.credential = createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
    } else if (env.TURN_USERNAME) {
      entry.username = env.TURN_USERNAME;
      entry.credential = env.TURN_CREDENTIAL || '';
    }
    servers.push(entry);
  }
  return servers;
}

/** Estado Live de una sala (se crea bajo demanda en el `entry` de la sala). */
export function createLiveState() {
  return {
    hosts: new Set(), // socket ids de animadores conectados
    viewers: new Map(), // socket id → { since, name }
    active: false,
    startedAt: null,
    producers: new Map(), // producerId → { kind, socketId, paused }
    game: { cfg: null, pool: new Map(), state: null },
    pendingReactions: new Map(),
    reactionTimer: null,
    countTimer: null,
    metrics: { viewers: 0, viewersPeak: 0, joins: 0, disconnects: 0, reconnections: 0, connectedMsTotal: 0, connectedSessions: 0, bingos: 0, reactions: 0, webrtcErrors: 0 },
  };
}

function liveInfo(live) {
  return {
    active: live.active,
    startedAt: live.startedAt,
    producers: [...live.producers.entries()].map(([producerId, p]) => ({ producerId, kind: p.kind, paused: p.paused })),
  };
}

function metricsOf(live) {
  const m = live.metrics;
  return {
    viewers: live.viewers.size,
    viewersPeak: m.viewersPeak,
    joins: m.joins,
    disconnects: m.disconnects,
    reconnections: m.reconnections,
    avgConnectedMs: m.connectedSessions ? Math.round(m.connectedMsTotal / m.connectedSessions) : 0,
    bingos: m.bingos,
    reactions: m.reactions,
    webrtcErrors: m.webrtcErrors,
    hostOnline: live.hosts.size > 0,
    live: liveInfo(live),
  };
}

function history(live) {
  const out = [];
  if (live.game.cfg) out.push(live.game.cfg);
  for (const i of [...live.game.pool.keys()].sort((a, b) => a - b)) out.push(live.game.pool.get(i));
  if (live.game.state) out.push(live.game.state);
  return out;
}

/** Valida un bingo con la última partida publicada: regenera la tarjeta (determinista) y la evalúa con las cantadas. */
export function validateBingo(live, claim) {
  const cfg = live.game.cfg ? JSON.parse(live.game.cfg) : null;
  const state = live.game.state ? JSON.parse(live.game.state) : null;
  if (!cfg || !state || cfg.seed !== claim.seed || state.seed !== claim.seed) return { valid: null };
  if (!Number.isInteger(claim.index) || claim.index < 0 || claim.index >= cfg.cardCount) return { valid: false, serverStatus: 'none' };
  const card = generateCard({ seed: cfg.seed, gridSize: cfg.gridSize, freeCenter: cfg.freeCenter, cardCount: cfg.cardCount, snippetSeconds: 20, startMode: 'random' }, cfg.poolSize, claim.index);
  const ev = evaluateCard(card, new Set(state.called));
  const valid = claim.kind === 'full' ? ev.status === 'full' : ev.status !== 'none';
  return { valid, serverStatus: ev.status };
}

function parseMessage(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return null;
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/**
 * Registra los handlers Live/Game en un socket. `ctx` lo entrega concert-server: sala de B-Talk, helpers
 * de transporte, emisor y rol resuelto en el servidor (nunca desde el cliente).
 */
export function attachLiveHandlers(ctx) {
  const { io, socket, roomId, entry, btalk, ensurePeer, waitFor, findProducer, log, env, isOperator } = ctx;
  const live = (entry.live ??= createLiveState());
  const role = isOperator ? 'host' : 'viewer';
  const hostsRoom = `live:${roomId}:hosts`;
  const allRoom = `live:${roomId}`;
  let joined = false;
  let lastReaction = 0;
  let lastBingo = 0;
  let lastClaim = 0;

  const broadcastCount = () => {
    if (live.countTimer) return;
    live.countTimer = setTimeout(() => {
      live.countTimer = null;
      io.to(allRoom).emit(E.playersCount, { viewers: live.viewers.size, hostOnline: live.hosts.size > 0 });
    }, 1000);
  };

  socket.on(E.join, (payload, ack) => {
    if (joined) return ok(ack, { role, roomId, hostOnline: live.hosts.size > 0, live: liveInfo(live), viewers: live.viewers.size, iceServers: iceServersFromEnv(env), history: history(live) });
    joined = true;
    socket.join(allRoom);
    if (role === 'host') {
      const wasOnline = live.hosts.size > 0;
      live.hosts.add(socket.id);
      socket.join(hostsRoom);
      if (!wasOnline) io.to(allRoom).emit(E.hostOnline, { t: Date.now() });
      log(`host online ${socket.id} en ${roomId}`);
    } else {
      live.viewers.set(socket.id, { since: Date.now(), name: String(payload?.name ?? '').slice(0, 40) });
      live.metrics.joins++;
      if (payload?.reconnect) live.metrics.reconnections++;
      live.metrics.viewersPeak = Math.max(live.metrics.viewersPeak, live.viewers.size);
      broadcastCount();
    }
    ok(ack, { role, roomId, hostOnline: live.hosts.size > 0, live: liveInfo(live), viewers: live.viewers.size, iceServers: iceServersFromEnv(env), history: history(live) });
  });

  /* ---------------- Transporte (1 publisher → N viewers) ---------------- */

  socket.on(E.rtpCapabilities, async (_p, ack) => {
    try {
      await waitFor(() => btalk.router);
      ok(ack, { rtpCapabilities: btalk.getRtpCapabilities() });
    } catch (err) {
      fail(ack, 'router', err.message);
    }
  });

  socket.on(E.createTransport, async (payload, ack) => {
    const direction = payload?.direction === 'recv' ? 'recv' : 'send';
    if (direction === 'send' && role !== 'host') return fail(ack, 'forbidden', 'Solo el animador publica vídeo/audio');
    try {
      await waitFor(() => btalk.router);
      ensurePeer();
      const params = await btalk.createWebRtcTransport(socket.id);
      ok(ack, { params });
    } catch (err) {
      live.metrics.webrtcErrors++;
      fail(ack, 'transport', err.message);
    }
  });

  socket.on(E.connectTransport, async (payload, ack) => {
    try {
      const done = await btalk.connectPeerTransport(socket.id, payload?.transportId, payload?.dtlsParameters);
      if (!done) return fail(ack, 'transport', 'Transporte desconocido');
      ok(ack);
    } catch (err) {
      live.metrics.webrtcErrors++;
      fail(ack, 'transport', err.message);
    }
  });

  socket.on(E.produce, async (payload, ack) => {
    if (role !== 'host') return fail(ack, 'forbidden', 'Solo el animador publica');
    const { transportId, kind, rtpParameters } = payload || {};
    if (kind !== 'audio' && kind !== 'video') return fail(ack, 'kind', 'Solo audio o vídeo');
    try {
      const appData = { source: 'live-host', mediaType: kind, roomId };
      const id = await btalk.produce(socket.id, transportId, rtpParameters, kind, kind, { appData, announce: false });
      live.producers.set(id, { kind, socketId: socket.id, paused: false });
      if (live.active) io.to(allRoom).emit(E.producerAdded, { producerId: id, kind, paused: false });
      log(`live producer ${kind} ${id}`);
      ok(ack, { id });
    } catch (err) {
      live.metrics.webrtcErrors++;
      fail(ack, 'produce', err.message);
    }
  });

  socket.on(E.consume, async (payload, ack) => {
    const { transportId, producerId, rtpCapabilities } = payload || {};
    const found = findProducer(btalk, producerId);
    if (!found || found.producer.appData?.source !== 'live-host') return fail(ack, 'unknown-producer', 'Producer desconocido');
    try {
      const params = await btalk.consume(socket.id, transportId, producerId, rtpCapabilities);
      if (!params) return fail(ack, 'consume', 'No se pudo consumir (capacidades RTP)');
      ok(ack, params);
    } catch (err) {
      live.metrics.webrtcErrors++;
      fail(ack, 'consume', err.message);
    }
  });

  socket.on(E.resumeConsumer, (_p, ack) => ok(ack));

  const setProducerPaused = async (producerId, paused, ack) => {
    if (role !== 'host') return fail(ack, 'forbidden', 'Solo el animador');
    const info = live.producers.get(producerId);
    const found = findProducer(btalk, producerId);
    if (!info || !found) return fail(ack, 'unknown-producer', 'Producer desconocido');
    try {
      if (paused) await found.producer.pause();
      else await found.producer.resume();
      info.paused = paused;
      io.to(allRoom).emit(E.producerState, { producerId, kind: info.kind, paused });
      ok(ack);
    } catch (err) {
      fail(ack, 'producer', err.message);
    }
  };
  socket.on(E.pauseProducer, (p, ack) => void setProducerPaused(p?.producerId, true, ack));
  socket.on(E.resumeProducer, (p, ack) => void setProducerPaused(p?.producerId, false, ack));

  socket.on(E.start, (_p, ack) => {
    if (role !== 'host') return fail(ack, 'forbidden', 'Solo el animador');
    live.active = true;
    live.startedAt = live.startedAt ?? Date.now();
    io.to(allRoom).emit(E.started, { ...liveInfo(live), t: Date.now() });
    log(`live started en ${roomId}`);
    ok(ack, liveInfo(live));
  });

  const stopLive = (reason) => {
    for (const [producerId, p] of live.producers) {
      const found = findProducer(btalk, producerId);
      if (found) found.peer.closeProducer(producerId);
      live.producers.delete(producerId);
      void p;
    }
    if (live.active) {
      live.active = false;
      live.startedAt = null;
      io.to(allRoom).emit(E.stopped, { reason, t: Date.now() });
      log(`live stopped en ${roomId} (${reason})`);
    }
  };
  socket.on(E.stop, (_p, ack) => {
    if (role !== 'host') return fail(ack, 'forbidden', 'Solo el animador');
    stopLive('host');
    ok(ack);
  });

  /* ---------------- Plano de juego ---------------- */

  socket.on(E.gamePublish, (payload, ack) => {
    if (role !== 'host') return fail(ack, 'forbidden', 'Solo el anfitrión publica el estado');
    const raw = payload?.message;
    const data = parseMessage(raw);
    if (!data) return fail(ack, 'message', 'Mensaje inválido');
    if (data.k === 'cfg') live.game.cfg = raw;
    else if (data.k === 'pool' && Number.isInteger(data.i)) live.game.pool.set(data.i, raw);
    else if (data.v === 1 && Array.isArray(data.called)) live.game.state = raw;
    else return fail(ack, 'message', 'Tipo de mensaje no admitido');
    socket.to(allRoom).emit(E.gameMessage, { message: raw });
    ok(ack);
  });

  socket.on(E.gameClaim, (payload, ack) => {
    const now = Date.now();
    if (now - lastClaim < CLAIM_MIN_MS) return fail(ack, 'rate', 'Demasiadas peticiones');
    lastClaim = now;
    const data = parseMessage(payload?.message);
    if (!data || data.k !== 'claim') return fail(ack, 'message', 'Petición inválida');
    if (live.hosts.size === 0) return fail(ack, 'host-offline', 'El anfitrión no está conectado');
    io.to(hostsRoom).emit(E.gameMessage, { message: payload.message });
    ok(ack);
  });

  socket.on(E.bingo, (payload, ack) => {
    const now = Date.now();
    if (now - lastBingo < BINGO_MIN_MS) return fail(ack, 'rate', 'Espera unos segundos antes de volver a cantar bingo');
    lastBingo = now;
    const claim = {
      seed: String(payload?.seed ?? ''),
      index: Number(payload?.index),
      name: String(payload?.name ?? '').slice(0, 40),
      cid: String(payload?.cid ?? '').slice(0, 64),
      kind: payload?.kind === 'line' ? 'line' : 'full',
      t: now,
    };
    if (!claim.seed || !Number.isInteger(claim.index)) return fail(ack, 'message', 'Bingo inválido');
    live.metrics.bingos++;
    const verdict = validateBingo(live, claim);
    io.to(hostsRoom).emit(E.bingoClaimed, { ...claim, ...verdict });
    ok(ack, verdict);
  });

  socket.on(E.winner, (payload, ack) => {
    if (role !== 'host') return fail(ack, 'forbidden', 'Solo el anfitrión anuncia ganadores');
    const w = { seed: String(payload?.seed ?? ''), index: Number(payload?.index), name: String(payload?.name ?? '').slice(0, 40), kind: payload?.kind === 'line' ? 'line' : 'full', t: Date.now() };
    io.to(allRoom).emit(E.winnerAnnounced, w);
    ok(ack);
  });

  /* ---------------- Reacciones (con límite y agregación) ---------------- */

  socket.on(E.reaction, (payload, ack) => {
    const emoji = payload?.emoji;
    if (!REACTIONS.includes(emoji)) return fail(ack, 'emoji', 'Reacción no admitida');
    const now = Date.now();
    if (now - lastReaction < REACTION_MIN_MS) return fail(ack, 'rate', 'Demasiado rápido');
    lastReaction = now;
    live.metrics.reactions++;
    live.pendingReactions.set(emoji, (live.pendingReactions.get(emoji) ?? 0) + 1);
    if (!live.reactionTimer) {
      live.reactionTimer = setTimeout(() => {
        live.reactionTimer = null;
        const counts = Object.fromEntries(live.pendingReactions);
        live.pendingReactions.clear();
        io.to(allRoom).emit(E.reactions, { counts, t: Date.now() });
      }, REACTION_FLUSH_MS);
    }
    ok(ack);
  });

  socket.on(E.metrics, (_p, ack) => {
    if (role !== 'host') return fail(ack, 'forbidden', 'Solo el animador');
    ok(ack, metricsOf(live));
  });
  let statsTimer = null;
  if (role === 'host') statsTimer = setInterval(() => socket.emit(E.stats, metricsOf(live)), STATS_MS);

  socket.on('disconnect', () => {
    if (statsTimer) clearInterval(statsTimer);
    if (!joined) return;
    if (role === 'host') {
      live.hosts.delete(socket.id);
      for (const [producerId, p] of [...live.producers]) if (p.socketId === socket.id) live.producers.delete(producerId);
      if (live.hosts.size === 0) {
        stopLive('host-disconnected');
        io.to(allRoom).emit(E.hostOffline, { t: Date.now() });
      }
    } else {
      const v = live.viewers.get(socket.id);
      if (v) {
        live.metrics.connectedMsTotal += Date.now() - v.since;
        live.metrics.connectedSessions++;
      }
      live.viewers.delete(socket.id);
      live.metrics.disconnects++;
      broadcastCount();
    }
  });
}

export function liveSummary(entry) {
  const live = entry.live;
  if (!live) return null;
  return { viewers: live.viewers.size, hostOnline: live.hosts.size > 0, active: live.active };
}
