import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConcertError, ConcertRoom, type MediaControl, type RoomEmitter } from '../src/concert/concert-room.js';
import { DEFAULT_CONFIG, canTransition, isCrowdMicAppData, readConfig, slotIds } from '../src/concert/protocol.js';

function makeRoom(overrides: Partial<typeof DEFAULT_CONFIG> = {}) {
  const calls: string[] = [];
  const media: MediaControl = {
    pauseProducer: (id) => void calls.push(`pause:${id}`),
    resumeProducer: (id) => void calls.push(`resume:${id}`),
    closeProducer: (id) => void calls.push(`close:${id}`),
  };
  const sent: { to: string; event: string; payload: unknown }[] = [];
  const emitter: RoomEmitter = {
    toParticipant: (pid, event, payload) => void sent.push({ to: pid, event, payload }),
    toOperators: (event, payload) => void sent.push({ to: 'operators', event, payload }),
  };
  let ids = 0;
  const room = new ConcertRoom('room1', { ...DEFAULT_CONFIG, concertMode: true, ...overrides }, media, emitter, { now: () => 1000, idGenerator: () => `p${++ids}`, disconnectGraceMs: 10 });
  return { room, calls, sent, media };
}

const appData = (pid: string, slotId: string, roomId = 'room1') => ({ mediaType: 'audio', source: 'crowd-mic', participantId: pid, roomId, slotId });

/** Lleva a un participante hasta PREPARED (simulando el teléfono). */
function prepareUntilPrepared(room: ConcertRoom, pid: string, producerId: string) {
  const slot = room.prepare('dj', pid);
  assert.ok(room.registerProducer(pid, producerId, appData(pid, slot.slotId)));
  room.prepared(pid, producerId);
  return slot.slotId;
}

test('máquina de estados: transiciones válidas e inválidas', () => {
  assert.ok(canTransition('CONNECTED', 'READY'));
  assert.ok(canTransition('READY', 'PREPARING'));
  assert.ok(canTransition('PREPARING', 'PREPARED'));
  assert.ok(canTransition('PREPARING', 'ERROR'));
  assert.ok(canTransition('PREPARED', 'LIVE'));
  assert.ok(canTransition('LIVE', 'MUTED') && canTransition('MUTED', 'LIVE'));
  assert.ok(canTransition('LIVE', 'READY') && canTransition('MUTED', 'READY'));
  assert.ok(canTransition('LIVE', 'DISCONNECTED'));
  assert.ok(!canTransition('READY', 'LIVE'), 'READY no puede pasar directamente a LIVE');
  assert.ok(!canTransition('CONNECTED', 'PREPARED'));
});

test('configuración desde variables de entorno', () => {
  const cfg = readConfig({ CONCERT_MODE: 'true', MAX_LIVE_MICS: '4', CONCERT_AUDIO_PROFILE: 'talk', CONCERT_NOISE_REDUCTION: 'strong', AEC_ENABLED: '0', REFERENCE_AUDIO_MODE: 'mixer', BTALK_URL: 'https://talk.example' });
  assert.equal(cfg.concertMode, true);
  assert.equal(cfg.maxLiveMics, 4);
  assert.equal(cfg.audioProfile, 'TALK');
  assert.equal(cfg.noiseReduction, 'STRONG');
  assert.equal(cfg.aecEnabled, false);
  assert.equal(cfg.btalkUrl, 'https://talk.example');
  assert.equal(readConfig({}).concertMode, false, 'por defecto se conserva el comportamiento actual');
  assert.deepEqual(slotIds(4), ['MIC_A', 'MIC_B', 'MIC_C', 'MIC_D']);
});

test('READY solo cambia estado: sin slot, sin producer', () => {
  const { room, calls } = makeRoom();
  const { participantId } = room.join('s1', { name: 'Ana' });
  room.ready(participantId);
  const p = room.participants.get(participantId)!;
  assert.equal(p.state, 'READY');
  assert.equal(p.slotId, undefined);
  assert.equal(p.producerId, undefined);
  assert.deepEqual(calls, [], 'ningún producer tocado');
  assert.equal(room.metrics().ready, 1);
});

test('PREPARE ordena al teléfono, registra como máximo un producer y GO LIVE hace resume', async () => {
  const { room, calls, sent } = makeRoom();
  const { participantId: pid } = room.join('s1', { name: 'Ana' });
  room.ready(pid);
  const slot = room.prepare('dj', pid);
  assert.equal(slot.slotId, 'MIC_A');
  assert.equal(room.participants.get(pid)!.state, 'PREPARING');
  const order = sent.find((m) => m.to === pid && m.event === 'concert:prepare');
  assert.deepEqual(order?.payload, { slotId: 'MIC_A', profile: 'SING' });
  assert.ok(room.registerProducer(pid, 'prod1', appData(pid, 'MIC_A')));
  assert.ok(!room.registerProducer(pid, 'prod2', appData(pid, 'MIC_A')), 'segundo producer rechazado');
  assert.ok(!room.registerProducer(pid, 'prod1', { mediaType: 'audio', source: 'webcam' }), 'appData incorrecto rechazado');
  room.prepared(pid, 'prod1');
  assert.equal(room.participants.get(pid)!.state, 'PREPARED');
  assert.deepEqual(calls, [], 'el producer sigue en pausa: el servidor no lo ha reanudado');
  await room.goLive('dj', pid);
  assert.deepEqual(calls, ['resume:prod1']);
  assert.equal(room.participants.get(pid)!.state, 'LIVE');
  assert.equal(room.slots.get('MIC_A')!.state, 'LIVE');
});

test('un participante no puede hacer GO LIVE ni preparar a otros', async () => {
  const { room } = makeRoom();
  const { participantId: pid } = room.join('s1', { name: 'Ana' });
  room.ready(pid);
  assert.throws(() => room.prepare('participant', pid), (e: ConcertError) => e.code === 'forbidden');
  prepareUntilPrepared(room, pid, 'prod1');
  await assert.rejects(room.goLive('participant', pid), (e: ConcertError) => e.code === 'forbidden');
  assert.equal(room.participants.get(pid)!.state, 'PREPARED');
});

test('dos LIVE con MAX_LIVE_MICS=2; el tercero se rechaza en el servidor', async () => {
  const { room } = makeRoom({ maxLiveMics: 2, maxPreparedMics: 3 });
  const ids = ['a', 'b', 'c'].map((n, i) => {
    const { participantId } = room.join(`s${i}`, { name: n });
    room.ready(participantId);
    return participantId;
  });
  prepareUntilPrepared(room, ids[0]!, 'pa');
  prepareUntilPrepared(room, ids[1]!, 'pb');
  await room.goLive('dj', ids[0]!);
  await room.goLive('dj', ids[1]!);
  assert.equal(room.metrics().live, 2);
  prepareUntilPrepared(room, ids[2]!, 'pc');
  await assert.rejects(room.goLive('dj', ids[2]!), (e: ConcertError) => e.code === 'max-live');
  assert.equal(room.participants.get(ids[2]!)!.state, 'PREPARED');
});

test('MAX_PREPARED_MICS limita las preparaciones simultáneas', () => {
  const { room } = makeRoom({ maxLiveMics: 2, maxPreparedMics: 2 });
  const ids = ['a', 'b', 'c'].map((n, i) => {
    const { participantId } = room.join(`s${i}`, { name: n });
    room.ready(participantId);
    return participantId;
  });
  room.prepare('dj', ids[0]!);
  room.prepare('dj', ids[1]!);
  assert.throws(() => room.prepare('dj', ids[2]!), (e: ConcertError) => e.code === 'max-prepared');
});

test('selective consume: solo dj/admin/audio-engine consumen crowd-mic', () => {
  const { room } = makeRoom();
  const data = appData('x', 'MIC_A');
  assert.ok(isCrowdMicAppData(data));
  assert.equal(room.canConsume('participant', data), false);
  assert.equal(room.canConsume('dj', data), true);
  assert.equal(room.canConsume('admin', data), true);
  assert.equal(room.canConsume('audio-engine', data), true);
  assert.equal(room.canConsume('participant', { mediaType: 'audio', source: 'mic' }), true, 'los producers normales siguen las reglas de B-Talk');
  assert.deepEqual(room.consumableProducers('participant'), []);
});

test('MUTE pausa, UNMUTE reanuda, END cierra el producer y libera el slot', async () => {
  const { room, calls } = makeRoom();
  const { participantId: pid } = room.join('s1', { name: 'Ana' });
  room.ready(pid);
  prepareUntilPrepared(room, pid, 'prod1');
  await room.goLive('dj', pid);
  await room.mute('dj', pid);
  assert.equal(room.participants.get(pid)!.state, 'MUTED');
  assert.equal(room.slots.get('MIC_A')!.state, 'MUTED');
  await room.unmute('dj', pid);
  assert.equal(room.participants.get(pid)!.state, 'LIVE');
  await room.end('dj', pid);
  assert.deepEqual(calls, ['resume:prod1', 'pause:prod1', 'resume:prod1', 'close:prod1']);
  const p = room.participants.get(pid)!;
  assert.equal(p.state, 'READY');
  assert.equal(p.producerId, undefined);
  assert.equal(p.slotId, undefined);
  assert.equal(room.slots.get('MIC_A')!.state, 'EMPTY');
  assert.deepEqual(room.consumableProducers('dj'), [], 'sin producers huérfanos');
});

test('CANCEL PREPARE y prepare-failed limpian recursos y devuelven a READY', async () => {
  const { room, calls, sent } = makeRoom();
  const { participantId: pid } = room.join('s1', { name: 'Ana' });
  room.ready(pid);
  room.prepare('dj', pid);
  room.registerProducer(pid, 'prod1', appData(pid, 'MIC_A'));
  await room.end('dj', pid); // cancelar
  assert.deepEqual(calls, ['close:prod1']);
  assert.equal(room.slots.get('MIC_A')!.state, 'EMPTY');
  assert.equal(room.participants.get(pid)!.state, 'READY');
  room.prepare('dj', pid);
  await room.prepareFailed(pid, 'permissionDenied', 'NotAllowedError');
  assert.equal(room.participants.get(pid)!.state, 'READY');
  assert.equal(room.slots.get('MIC_A')!.state, 'EMPTY');
  const failed = sent.find((m) => m.event === 'concert:prepare-failed');
  assert.deepEqual(failed?.payload, { participantId: pid, slotId: 'MIC_A', reason: 'permissionDenied', detail: 'NotAllowedError' });
});

test('el participante siempre puede apagar su propio micrófono', async () => {
  const { room, calls } = makeRoom();
  const { participantId: pid } = room.join('s1', { name: 'Ana' });
  room.ready(pid);
  prepareUntilPrepared(room, pid, 'prod1');
  await room.goLive('dj', pid);
  await room.stopMyMic(pid);
  assert.equal(room.participants.get(pid)!.state, 'READY');
  assert.ok(calls.includes('close:prod1'));
});

test('reconexión: nuevo socket.id conserva participantId y estado; sin producers duplicados', async () => {
  const { room, sent } = makeRoom();
  const { participantId: pid } = room.join('s1', { name: 'Ana' });
  room.ready(pid);
  room.disconnect('s1');
  const again = room.join('s2', { name: 'Ana', participantId: pid });
  assert.equal(again.participantId, pid);
  assert.equal(again.state, 'READY', 'recupera READY');
  assert.equal(room.participantBySocket('s2')?.participantId, pid);
  assert.equal(room.participantBySocket('s1'), undefined);
  // En vivo, una caída avisa al DJ y no permite un segundo producer al reconectar
  prepareUntilPrepared(room, pid, 'prod1');
  await room.goLive('dj', pid);
  room.disconnect('s2');
  assert.ok(sent.some((m) => m.event === 'concert:error' && (m.payload as { code: string }).code === 'participant-lost'));
  room.join('s3', { name: 'Ana', participantId: pid });
  assert.equal(room.participants.get(pid)!.state, 'LIVE');
  assert.ok(!room.registerProducer(pid, 'prod2', appData(pid, 'MIC_A')), 'no se acepta un segundo producer');
});

test('READY caducado tras el periodo de gracia se elimina', async () => {
  const { room, sent } = makeRoom();
  const { participantId: pid } = room.join('s1', { name: 'Ana' });
  room.ready(pid);
  room.disconnect('s1');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(room.participants.has(pid), false);
  assert.ok(sent.some((m) => m.event === 'concert:participant-removed'));
});

test('cambiar de canción no toca a los READY; listado paginado y búsqueda', () => {
  const { room, sent } = makeRoom();
  for (let i = 0; i < 25; i++) {
    const { participantId } = room.join(`s${i}`, { name: `Persona ${i}`, sector: i % 2 ? 'A' : 'B', asiento: String(100 + i) });
    room.ready(participantId);
  }
  sent.length = 0;
  room.setNowPlaying({ title: 'Bohemian Rhapsody', artist: 'Queen' });
  assert.equal(room.metrics().ready, 25);
  assert.ok(!sent.some((m) => m.event === 'concert:participant-updated'), 'ningún participante cambia');
  const page = room.list({ state: 'READY', limit: 10, offset: 10 });
  assert.equal(page.total, 25);
  assert.equal(page.items.length, 10);
  const search = room.list({ query: '10' });
  assert.ok(search.items.every((p) => p.name.includes('10') || p.asiento?.includes('10')));
  assert.ok(!('socketId' in page.items[0]!) && !('producerId' in page.items[0]!), 'no se filtran datos internos');
});
