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
