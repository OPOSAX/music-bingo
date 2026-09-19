/**
 * Prueba de humo del servidor Concert: arranca mediasoup + Socket.IO en un puerto libre y recorre la
 * señalización con clientes reales de socket.io-client (sin WebRTC de navegador).
 *   node server/test/smoke.mjs
 */
import { io } from 'socket.io-client';

// La config de mediasoup (btalk/config.js) lee process.env al cargarse: fijar antes de importar el servidor.
process.env.MEDIASOUP_WORKERS = '1';
process.env.BTALK_ANNOUNCED_IP = '127.0.0.1';
const { startServer } = await import('../concert-server.mjs');

const server = await startServer({ port: 0, env: { CONCERT_DJ_TOKEN: 'dj-secret', CONCERT_GRACE_MS: '200', MEDIASOUP_WORKERS: '1', NODE_ENV: 'production' } });
const url = `http://127.0.0.1:${server.port}`;
const results = [];
const step = (name, okFlag) => {
  results.push(`${okFlag ? 'ok ' : 'FAIL'} ${name}`);
  if (!okFlag) throw new Error(`Fallo: ${name}`);
};

const connect = (auth, target = url) =>
  new Promise((resolve, reject) => {
    const socket = io(target, { transports: ['websocket'], auth, reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
const request = (socket, event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
const waitEvent = (socket, event, timeout = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`sin evento ${event}`)), timeout);
    socket.once(event, (payload) => {
      clearTimeout(t);
      resolve(payload);
    });
  });

try {
  const health = await fetch(`${url}/health`).then((r) => r.json());
  step('health responde concert:true', health.concert === true && health.workers === 1);
  const sfu = await fetch(`${url}/sfu/MediasoupClient.js`);
  step('bundle mediasoup-client servido', sfu.ok && /mediasoupClient/.test(await sfu.text()));

  const phone = await connect({ roomId: 'smoke' });
  const dj = await connect({ roomId: 'smoke', token: 'dj-secret' });
  const intruder = await connect({ roomId: 'smoke', token: 'wrong' });

  const joinDj = await request(dj, 'concert:join', { roomId: 'smoke', meta: { name: 'DJ' } });
  step('DJ join', joinDj.ok === true);
  const joinPhone = await request(phone, 'concert:join', { roomId: 'smoke', participantId: 'phone-1', meta: { name: 'Ana' } });
  step('participante join', joinPhone.ok === true && joinPhone.participantId === 'phone-1' && joinPhone.state === 'CONNECTED');
  const ready = await request(phone, 'concert:ready');
  step('participante READY', ready.ok === true);

  const listByIntruder = await request(intruder, 'concert:list', {});
  step('token incorrecto no es operador', listByIntruder.ok === false && listByIntruder.code === 'forbidden');
  const listByPhone = await request(phone, 'concert:list', {});
  step('participante no puede listar', listByPhone.ok === false);
  const list = await request(dj, 'concert:list', { state: 'READY' });
  step('DJ lista READY', list.ok === true && list.total === 1 && list.items[0].name === 'Ana');

  const caps = await request(phone, 'concert:rtp-capabilities');
  step('rtpCapabilities con opus', caps.ok === true && caps.rtpCapabilities.codecs.some((c) => c.mimeType === 'audio/opus'));

  const early = await request(phone, 'concert:create-transport', { direction: 'send' });
  step('sin PREPARE no hay transporte', early.ok === false && early.code === 'not-preparing');

  const orderPromise = waitEvent(phone, 'concert:prepare');
  const prepare = await request(dj, 'concert:prepare', { participantId: 'phone-1' });
  step('DJ PREPARE', prepare.ok === true && prepare.slot.slotId === 'MIC_A');
  const order = await orderPromise;
  step('teléfono recibe la orden con perfil', order.slotId === 'MIC_A' && ['SING', 'TALK'].includes(order.profile));

  const recvByPhone = await request(phone, 'concert:create-transport', { direction: 'recv' });
  step('participante no crea RECV transport', recvByPhone.ok === false && recvByPhone.code === 'forbidden');
  const sendByDj = await request(dj, 'concert:create-transport', { direction: 'send' });
  step('DJ no crea SEND transport', sendByDj.ok === false && sendByDj.code === 'forbidden');

  const send = await request(phone, 'concert:create-transport', { direction: 'send' });
  step('SEND transport creado en PREPARE', send.ok === true && Array.isArray(send.params.iceCandidates) && send.params.id);
  const recv = await request(dj, 'concert:create-transport', { direction: 'recv' });
  step('RECV transport del DJ', recv.ok === true && recv.params.id);

  const badAppData = await request(phone, 'concert:produce', { transportId: send.params.id, kind: 'audio', rtpParameters: {}, appData: { mediaType: 'audio', source: 'crowd-mic', participantId: 'otro', roomId: 'smoke', slotId: 'MIC_A' } });
  step('produce con appData ajeno rechazado', badAppData.ok === false && badAppData.code === 'appData');
  const videoProduce = await request(phone, 'concert:produce', { transportId: send.params.id, kind: 'video', rtpParameters: {}, appData: { mediaType: 'audio', source: 'crowd-mic', participantId: 'phone-1', roomId: 'smoke', slotId: 'MIC_A' } });
  step('produce de vídeo rechazado', videoProduce.ok === false && videoProduce.code === 'kind');

  const cancel = await request(dj, 'concert:end', { participantId: 'phone-1' });
  step('CANCEL vuelve a READY', cancel.ok === true);
  const metrics = await request(dj, 'concert:metrics');
  step('métricas tras CANCEL', metrics.ready === 1 && metrics.preparing === 0 && metrics.slots[0].state === 'EMPTY');

  const stop = await request(phone, 'concert:stop-my-mic');
  step('stop-my-mic siempre permitido', stop.ok === true);
  const leave = await request(phone, 'concert:leave');
  step('leave', leave.ok === true);

  /* ---------------- Bingo Hit Live ---------------- */
  const host = await connect({ roomId: 'bingo-EV1', token: 'dj-secret' });
  const viewer = await connect({ roomId: 'bingo-EV1' });
  const viewerJoin = await request(viewer, 'live:join', { name: 'Ana' });
  step('viewer join: rol viewer, sin host, sin live', viewerJoin.ok === true && viewerJoin.role === 'viewer' && viewerJoin.hostOnline === false && viewerJoin.live.active === false && Array.isArray(viewerJoin.iceServers));
  const hostOnlinePromise = waitEvent(viewer, 'live:host_online');
  const hostJoin = await request(host, 'live:join', {});
  step('host join: rol host', hostJoin.ok === true && hostJoin.role === 'host');
  await hostOnlinePromise;
  step('viewer recibe host_online', true);
  const sendByViewer = await request(viewer, 'live:create-transport', { direction: 'send' });
  step('viewer no publica', sendByViewer.ok === false && sendByViewer.code === 'forbidden');
  const recvByViewer = await request(viewer, 'live:create-transport', { direction: 'recv' });
  step('viewer crea RECV transport', recvByViewer.ok === true && recvByViewer.params.id);
  const sendByHost = await request(host, 'live:create-transport', { direction: 'send' });
  step('host crea SEND transport', sendByHost.ok === true && sendByHost.params.id);
  const startedPromise = waitEvent(viewer, 'live:started');
  const started = await request(host, 'live:start');
  step('host start', started.ok === true && started.active === true);
  await startedPromise;
  step('viewer recibe live:started', true);
  const startByViewer = await request(viewer, 'live:start');
  step('viewer no puede iniciar la transmisión', startByViewer.ok === false);

  // Plano de juego: cfg + estado por WebSocket, histórico para el que llega tarde y validación de bingo.
  const cfg = JSON.stringify({ k: 'cfg', seed: 'EV1', gridSize: 3, freeCenter: false, cardCount: 4, poolSize: 12, topic: 't', title: 'Smoke' });
  const publishByViewer = await request(viewer, 'game:publish', { message: cfg });
  step('viewer no publica estado', publishByViewer.ok === false && publishByViewer.code === 'forbidden');
  const msgPromise = waitEvent(viewer, 'game:message');
  step('host publica cfg', (await request(host, 'game:publish', { message: cfg })).ok === true);
  step('viewer recibe cfg', JSON.parse((await msgPromise).message).k === 'cfg');
  const { generateCard } = await import('../../public/js/bingo.js');
  const card = generateCard({ seed: 'EV1', gridSize: 3, freeCenter: false, cardCount: 4, snippetSeconds: 20, startMode: 'random' }, 12, 1);
  const state = JSON.stringify({ v: 1, seed: 'EV1', called: card.cells, revealed: true, autoMark: 'played', t: Date.now() });
  step('host publica estado', (await request(host, 'game:publish', { message: state })).ok === true);
  const late = await connect({ roomId: 'bingo-EV1' });
  const lateJoin = await request(late, 'live:join', { name: 'Tarde' });
  step('el que llega tarde recibe histórico (cfg + estado) y live activo', lateJoin.history.length === 2 && lateJoin.live.active === true && lateJoin.hostOnline === true);
  const claimPromise = waitEvent(host, 'live:bingo_claimed');
  const bingo = await request(viewer, 'live:bingo', { seed: 'EV1', index: 1, name: 'Ana', cid: 'c1', kind: 'full' });
  step('bingo validado por el servidor', bingo.ok === true && bingo.valid === true && bingo.serverStatus === 'full');
  const claimed = await claimPromise;
  step('host recibe el bingo con veredicto', claimed.name === 'Ana' && claimed.valid === true);
  const bingoAgain = await request(viewer, 'live:bingo', { seed: 'EV1', index: 1, name: 'Ana', cid: 'c1', kind: 'full' });
  step('bingo con límite de frecuencia', bingoAgain.ok === false && bingoAgain.code === 'rate');
  const winnerByViewer = await request(viewer, 'live:winner', { seed: 'EV1', index: 1, name: 'Ana', kind: 'full' });
  step('viewer no anuncia ganador', winnerByViewer.ok === false);
  const winnerPromise = waitEvent(late, 'live:winner_announced');
  step('host anuncia ganador', (await request(host, 'live:winner', { seed: 'EV1', index: 1, name: 'Ana', kind: 'full' })).ok === true);
  step('todos reciben winner_announced', (await winnerPromise).name === 'Ana');
  const reactionsPromise = waitEvent(late, 'live:reactions');
  const r1 = await request(viewer, 'live:reaction', { emoji: '🔥' });
  const r2 = await request(viewer, 'live:reaction', { emoji: '🔥' });
  const r3 = await request(viewer, 'live:reaction', { emoji: '💩' });
  step('reacciones: aceptada, limitada y emoji no admitido', r1.ok === true && r2.ok === false && r2.code === 'rate' && r3.ok === false);
  step('reacciones agregadas para todos', (await reactionsPromise).counts['🔥'] === 1);
  const liveMetrics = await request(host, 'live:metrics');
  step('métricas del host', liveMetrics.ok === true && liveMetrics.viewers === 2 && liveMetrics.bingos === 2 && liveMetrics.reactions === 1 && liveMetrics.viewersPeak >= 2);
  const metricsByViewer = await request(viewer, 'live:metrics');
  step('viewer no lee métricas', metricsByViewer.ok === false);
  const stoppedPromise = waitEvent(viewer, 'live:stopped');
  const offlinePromise = waitEvent(viewer, 'live:host_offline');
  host.disconnect();
  await stoppedPromise;
  await offlinePromise;
  step('al caer el host: live:stopped y host_offline', true);
  viewer.disconnect();
  late.disconnect();

  phone.disconnect();
  dj.disconnect();
  intruder.disconnect();
  await new Promise((r) => setTimeout(r, 400));
  const disabled = await startServer({ port: 0, env: { CONCERT_MODE: 'false', CONCERT_DJ_TOKEN: 'x', MEDIASOUP_WORKERS: '1', NODE_ENV: 'production' } });
  const s2 = await connect({ roomId: 'off' }, `http://127.0.0.1:${disabled.port}`);
  const joinOff = await request(s2, 'concert:join', { roomId: 'off', meta: { name: 'X' } });
  step('CONCERT_MODE=false rechaza join', joinOff.ok === false && joinOff.code === 'disabled');
  s2.disconnect();
  await disabled.close();
  console.log(results.join('\n'));
  console.log(`\n${results.length} comprobaciones OK`);
} catch (err) {
  console.log(results.join('\n'));
  console.error('SMOKE FAILED:', err);
  process.exitCode = 1;
} finally {
  await server.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
}
