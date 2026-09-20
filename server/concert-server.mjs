/**
 * Servidor Concert Mode (Biznet Crowd Mic) para el bingo musical.
 *
 * Reutiliza el núcleo SFU de Biznet Talk (server/btalk: Room, Peer, Logger, config de mediasoup) y
 * le añade los handlers `concert:*` compilados desde src/concert (public/js/concert). Sirve además
 * la propia app estática (public/) y el bundle mediasoup-client de B-Talk (/sfu/MediasoupClient.js).
 *
 * Variables: PORT (3010), CONCERT_MODE, MAX_LIVE_MICS, MAX_PREPARED_MICS, CONCERT_AUDIO_PROFILE,
 * CONCERT_NOISE_REDUCTION, AEC_ENABLED, REFERENCE_AUDIO_MODE, CONCERT_DJ_TOKEN, CONCERT_ADMIN_TOKEN,
 * BTALK_ANNOUNCED_IP, RTC_MIN_PORT, RTC_MAX_PORT, MEDIASOUP_WORKERS, STATIC_DIR.
 */

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import mediasoup from 'mediasoup';
import { Server as SocketServer } from 'socket.io';

import { ConcertRoom } from '../public/js/concert/concert-room.js';
import { isCrowdMicAppData, readConfig } from '../public/js/concert/protocol.js';
import { assertCanConsume, attachConcertHandlers } from '../public/js/concert/server-handlers.js';
import { attachLiveHandlers, iceServersFromEnv, liveSummary } from './live.mjs';
import { hashToken, identify } from './platform/auth.mjs';
import { createPlatformApi } from './platform/api.mjs';
import { PlatformService } from './platform/service.mjs';
import { Store } from './platform/store.mjs';

const require = createRequire(import.meta.url);
const config = require('./btalk/config.js');
const Logger = require('./btalk/Logger.js');
const Room = require('./btalk/Room.js');
const Peer = require('./btalk/Peer.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const log = new Logger('Concert');

const TRANSPORT_EVENTS = {
    rtpCapabilities: 'concert:rtp-capabilities',
    createTransport: 'concert:create-transport',
    connectTransport: 'concert:connect-transport',
    produce: 'concert:produce',
    consume: 'concert:consume',
    resumeConsumer: 'concert:resume-consumer',
};

function ok(ack, data = {}) {
    if (typeof ack === 'function') ack({ ok: true, ...data });
}

function fail(ack, code, message) {
    if (typeof ack === 'function') ack({ ok: false, code, message });
}

function waitFor(check, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            const value = check();
            if (value) return resolve(value);
            if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
            setTimeout(tick, 20);
        };
        tick();
    });
}

function findProducer(btalkRoom, producerId) {
    for (const peer of btalkRoom.getPeers().values()) {
        const producer = peer.getProducer(producerId);
        if (producer) return { peer, producer };
    }
    return null;
}

export async function startServer(options = {}) {
    const env = { ...process.env, ...options.env };
    const port = options.port ?? Number(env.PORT || 3010);
    const staticDir = env.STATIC_DIR ? path.resolve(env.STATIC_DIR) : path.resolve(here, '..', 'public');
    const concertConfig = readConfig({ ...env, CONCERT_MODE: env.CONCERT_MODE ?? 'true' });

    // Tokens de operador: nunca en el código. Si falta el del DJ se genera uno por arranque y se imprime.
    const djToken = env.CONCERT_DJ_TOKEN || env.LIVE_HOST_TOKEN || randomBytes(12).toString('hex');
    const liveHostToken = env.LIVE_HOST_TOKEN || djToken;
    const adminToken = env.CONCERT_ADMIN_TOKEN || '';
    if (!env.CONCERT_DJ_TOKEN && !env.LIVE_HOST_TOKEN) log.warn('CONCERT_DJ_TOKEN / LIVE_HOST_TOKEN no definidos: token de animador/DJ para este arranque', { token: djToken });

    // ---- Plataforma Bingo Hit: animadores, eventos, tarjetas, órdenes y pagos centralizados ----
    const platformAdminToken = env.PLATFORM_ADMIN_TOKEN || randomBytes(18).toString('base64url');
    if (!env.PLATFORM_ADMIN_TOKEN) log.warn('PLATFORM_ADMIN_TOKEN no definido: token del Administrador General para este arranque', { token: platformAdminToken });
    const dataFile = env.PLATFORM_DATA_FILE === 'memory' ? null : path.resolve(env.PLATFORM_DATA_FILE || path.join(here, 'data', 'platform.json'));
    let store;
    try {
        store = new Store(dataFile);
    } catch (err) {
        log.error('No se pudo abrir el almacén de la plataforma', { dataFile, error: err.message });
        throw err;
    }
    const publicUrl = (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '');
    const platform = new PlatformService(store, {
        env,
        appUrl: `${publicUrl}/`,
        apiUrl: publicUrl,
        log: (m) => log.info(m),
        liveState: () => ({
            concurrentPlayers: [...rooms.values()].reduce((n, r) => n + (r.live?.viewers.size ?? 0), 0),
            liveEvents: [...rooms.values()].filter((r) => r.live?.active).length,
        }),
    });
    const platformAdminHash = hashToken(platformAdminToken);
    if (!env.PLATFORM_ADMIN_PASSWORD) log.warn('PLATFORM_ADMIN_PASSWORD no definida: el inicio de sesión del administrador con usuario y contraseña está desactivado (usa el token)');
    const platformApi = createPlatformApi(platform, { adminToken: platformAdminToken, adminUser: env.PLATFORM_ADMIN_USER || 'admin', adminPassword: env.PLATFORM_ADMIN_PASSWORD || '', mockPayments: env.MOCK_PAYMENTS !== 'false' });

    // ---- mediasoup workers (adaptado de B-Talk Server.js createWorkers) ----
    const workers = [];
    const { numWorkers } = config.mediasoup;
    const { logLevel, logTags, rtcMinPort, rtcMaxPort, disableLiburing } = config.mediasoup.worker;
    for (let i = 0; i < numWorkers; i++) {
        const worker = await mediasoup.createWorker({ logLevel, logTags, rtcMinPort, rtcMaxPort, disableLiburing });
        worker.on('died', () => {
            log.error('Mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
            setTimeout(() => process.exit(1), 2000);
        });
        workers.push(worker);
    }
    let nextWorker = 0;
    const getWorker = () => workers[nextWorker++ % workers.length];
    log.info('Concert SFU', { workers: workers.length, announcedAddress: config.announcedAddress, rtcPorts: `${rtcMinPort}-${rtcMaxPort}`, config: concertConfig });

    // ---- HTTP: app estática + bundle mediasoup-client + health ----
    const app = express();
    app.disable('x-powered-by');
    app.get('/health', (_req, res) => {
        res.json({
            status: 'ok',
            concert: true,
            concertMode: concertConfig.concertMode,
            uptime: process.uptime(),
            rooms: rooms.size,
            participants: [...rooms.values()].reduce((n, r) => n + r.concert.participants.size, 0),
            live: Object.fromEntries([...rooms].map(([id, r]) => [id, liveSummary(r)]).filter(([, v]) => v)),
            workers: workers.length,
        });
    });
    // Configuración pública para el cliente Live (sin secretos: las credenciales TURN son temporales si hay TURN_SECRET).
    app.get('/live/config', (_req, res) => {
        res.json({ live: true, iceServers: iceServersFromEnv(env), maxViewersHint: Number(env.LIVE_MAX_VIEWERS) || 5000 });
    });
    app.use((req, res, next) => {
        platformApi(req, res).then((handled) => {
            if (!handled) next();
        }, next);
    });
    app.use('/sfu', express.static(path.join(here, 'public', 'sfu'), { maxAge: '1d' }));
    if (existsSync(staticDir)) {
        app.use(express.static(staticDir, { index: 'index.html', etag: true }));
        const versionFile = path.join(staticDir, 'version.txt');
        app.get('/version.txt', (_req, res) => {
            res.type('text/plain').send(existsSync(versionFile) ? readFileSync(versionFile, 'utf8') : env.APP_VERSION || 'dev');
        });
    }
    const httpServer = createServer(app);
    const io = new SocketServer(httpServer, { cors: { origin: env.CORS_ORIGIN || true }, serveClient: true });

    // ---- Salas: una Room de B-Talk (router mediasoup) + un ConcertRoom por roomId ----
    const rooms = new Map();
    const opsRoom = (roomId) => `concert:${roomId}:operators`;

    function getRoom(roomId) {
        let entry = rooms.get(roomId);
        if (entry) return entry;
        const btalk = new Room(roomId, getWorker(), io);
        const media = {
            pauseProducer: (id) => findProducer(btalk, id)?.producer.pause(),
            resumeProducer: (id) => findProducer(btalk, id)?.producer.resume(),
            closeProducer: (id) => {
                const found = findProducer(btalk, id);
                if (found) found.peer.closeProducer(id);
            },
        };
        const emitter = {
            toParticipant: (participantId, event, payload) => {
                const p = entry?.concert.participants.get(participantId);
                if (p?.socketId) io.to(p.socketId).emit(event, payload);
            },
            toOperators: (event, payload) => io.to(opsRoom(roomId)).emit(event, payload),
        };
        const concert = new ConcertRoom(roomId, concertConfig, media, emitter, { disconnectGraceMs: Number(env.CONCERT_GRACE_MS) || 30000 });
        entry = { btalk, concert, sockets: 0 };
        rooms.set(roomId, entry);
        log.info('Room created', { roomId });
        return entry;
    }

    function dropRoomIfEmpty(roomId) {
        const entry = rooms.get(roomId);
        if (!entry || entry.sockets > 0 || entry.concert.participants.size > 0) return;
        try {
            entry.btalk.closeRouter();
        } catch {
            /* ya cerrado */
        }
        rooms.delete(roomId);
        log.info('Room closed', { roomId });
    }

    function roleFor(socket, roomId) {
        const token = String(socket.handshake.auth?.token || '');
        if (adminToken && token === adminToken) return { role: 'admin' };
        if (token === djToken || token === liveHostToken) return { role: 'dj' };
        // Identidades de la plataforma: el rol y la propiedad del evento se comprueban aquí, nunca en el cliente.
        const who = identify(store, token, platformAdminHash);
        if (who.role === 'PLATFORM_ADMIN') return { role: 'admin', who };
        if (who.role === 'HOST' && platform.canOperateRoom(who.user, roomId)) return { role: 'dj', who };
        // Un animador activo también puede operar salas de partidas sin evento registrado (QR clásico).
        if (who.role === 'HOST' && who.user.status === 'ACTIVE' && !platform.eventByRoom(roomId)) return { role: 'dj', who };
        if (who.role === 'PLAYER') return { role: 'participant', who };
        return { role: 'participant', who: { role: 'ANON' } };
    }

    /** Acceso al plano Live/juego de un evento de la plataforma (los eventos sin registro siguen siendo libres). */
    function canJoinRoom(roomId, who) {
        const event = platform.eventByRoom(roomId);
        if (!event) return { ok: true };
        if (who?.role === 'HOST' || who?.role === 'PLATFORM_ADMIN') return { ok: true };
        if (event.eventMode === 'LOCAL' && event.cardDistribution === 'FREE') return { ok: true };
        if (who?.role !== 'PLAYER') return { ok: false, reason: 'card-required' };
        const access = platform.canPlayerJoinEvent(who.id, event.id);
        return access.allowed ? { ok: true } : { ok: false, reason: access.reason };
    }

    function canStartLiveIn(roomId, who) {
        const event = platform.eventByRoom(roomId);
        if (!event || !who || who.role === 'PLATFORM_ADMIN') return true;
        return who.role === 'HOST' && who.user?.permissions?.canStartLive !== false && event.hostId === who.id;
    }

    io.on('connection', (socket) => {
        const roomId = String(socket.handshake.auth?.roomId || 'demo').slice(0, 64);
        const { role, who } = roleFor(socket, roomId);
        const isOperator = role === 'dj' || role === 'admin';
        const entry = getRoom(roomId);
        entry.sockets++;
        const { btalk, concert } = entry;
        log.debug('Socket connected', { socketId: socket.id, roomId, role });

        const detach = attachConcertHandlers(concert, socket, role, { log: (m) => log.debug(m) });
        // Bingo Hit Live comparte sala, peer y transportes con el módulo Concert.
        attachLiveHandlers({ io, socket, roomId, entry, btalk, ensurePeer: () => ensurePeer(), waitFor, findProducer, log: (m) => log.debug(m), env, isOperator, canJoin: () => canJoinRoom(roomId, who), canStartLive: () => canStartLiveIn(roomId, who) });
        socket.on('concert:join', () => {
            if (isOperator) socket.join(opsRoom(roomId));
        });

        // Peer de B-Talk creado bajo demanda (solo quien crea transportes ocupa recursos en mediasoup).
        const ensurePeer = () => {
            let peer = btalk.getPeer(socket.id);
            if (peer) return peer;
            const participant = concert.participantBySocket(socket.id);
            peer = new Peer(socket.id, {
                peer_info: {
                    peer_uuid: socket.id,
                    peer_name: participant?.name || role,
                    peer_presenter: isOperator,
                    peer_audio: false,
                    peer_video: false,
                    peer_video_privacy: false,
                    peer_recording: false,
                    peer_hand: false,
                },
            });
            btalk.addPeer(peer);
            return peer;
        };

        socket.on(TRANSPORT_EVENTS.rtpCapabilities, async (_payload, ack) => {
            try {
                await waitFor(() => btalk.router);
                ok(ack, { rtpCapabilities: btalk.getRtpCapabilities() });
            } catch (err) {
                fail(ack, 'router', err.message);
            }
        });

        socket.on(TRANSPORT_EVENTS.createTransport, async (payload, ack) => {
            const direction = payload?.direction === 'recv' ? 'recv' : 'send';
            // El teléfono solo envía; el DJ/motor solo recibe.
            if (direction === 'send' && isOperator) return fail(ack, 'forbidden', 'Los operadores no envían audio');
            if (direction === 'recv' && !isOperator) return fail(ack, 'forbidden', 'Los participantes no reciben audio');
            if (!isOperator) {
                const p = concert.participantBySocket(socket.id);
                if (!p || p.state !== 'PREPARING') return fail(ack, 'not-preparing', 'Solo se crea el transporte durante PREPARE');
            }
            try {
                await waitFor(() => btalk.router);
                ensurePeer();
                const params = await btalk.createWebRtcTransport(socket.id);
                ok(ack, { params });
            } catch (err) {
                fail(ack, 'transport', err.message);
            }
        });

        socket.on(TRANSPORT_EVENTS.connectTransport, async (payload, ack) => {
            try {
                const done = await btalk.connectPeerTransport(socket.id, payload?.transportId, payload?.dtlsParameters);
                if (!done) return fail(ack, 'transport', 'Transporte desconocido');
                ok(ack);
            } catch (err) {
                fail(ack, 'transport', err.message);
            }
        });

        socket.on(TRANSPORT_EVENTS.produce, async (payload, ack) => {
            if (isOperator) return fail(ack, 'forbidden', 'Los operadores no producen audio');
            const p = concert.participantBySocket(socket.id);
            if (!p) return fail(ack, 'not-joined', 'Primero concert:join');
            const { transportId, kind, rtpParameters, appData } = payload || {};
            if (kind !== 'audio') return fail(ack, 'kind', 'Solo audio');
            if (!isCrowdMicAppData(appData) || appData.participantId !== p.participantId || appData.roomId !== roomId) return fail(ack, 'appData', 'appData inválido');
            try {
                const id = await btalk.produce(socket.id, transportId, rtpParameters, kind, 'audio', { appData, paused: true, announce: false });
                if (!concert.registerProducer(p.participantId, id, appData)) {
                    btalk.closeProducer(socket.id, id);
                    return fail(ack, 'rejected', 'Producer rechazado (estado o slot incorrecto)');
                }
                log.debug('crowd-mic producer created (paused)', { participantId: p.participantId, slotId: appData.slotId, producerId: id });
                ok(ack, { id });
            } catch (err) {
                fail(ack, 'produce', err.message);
            }
        });

        socket.on(TRANSPORT_EVENTS.consume, async (payload, ack) => {
            const { transportId, producerId, rtpCapabilities } = payload || {};
            const found = findProducer(btalk, producerId);
            if (!found) return fail(ack, 'unknown-producer', 'Producer desconocido');
            try {
                assertCanConsume(concert, role, found.producer.appData);
                const params = await btalk.consume(socket.id, transportId, producerId, rtpCapabilities);
                if (!params) return fail(ack, 'consume', 'No se pudo consumir (capacidades RTP)');
                ok(ack, params);
            } catch (err) {
                fail(ack, err.code || 'consume', err.message);
            }
        });

        socket.on(TRANSPORT_EVENTS.resumeConsumer, (_payload, ack) => ok(ack));

        socket.on('disconnect', () => {
            entry.sockets--;
            detach();
            const peer = btalk.getPeer(socket.id);
            if (peer) {
                // Como Room.removePeer de B-Talk, pero sin cerrar el router: los READY siguen en la sala sin peer.
                peer.close();
                btalk.getPeers().delete(socket.id);
            }
            setTimeout(() => dropRoomIfEmpty(roomId), (Number(env.CONCERT_GRACE_MS) || 30000) + 1000);
        });
    });

    await new Promise((resolve) => httpServer.listen(port, '0.0.0.0', resolve));
    const address = httpServer.address();
    log.info('Concert server listening', { port: address.port, static: existsSync(staticDir) ? staticDir : '(sin app estática)' });

    return {
        port: address.port,
        io,
        rooms,
        djToken,
        close: async () => {
            io.close();
            await new Promise((resolve) => httpServer.close(resolve));
            for (const w of workers) w.close();
        },
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    startServer().catch((err) => {
        log.error('No se pudo arrancar el servidor', err);
        process.exit(1);
    });
}
