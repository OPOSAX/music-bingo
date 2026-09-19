import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DjClient } from '../src/concert/dj-client.js';
import { ConcertMediaService, LocalMediaAdapter } from '../src/concert/media-service.js';
import { ParticipantClient } from '../src/concert/participant-client.js';
import { DEFAULT_CONFIG, EVENTS } from '../src/concert/protocol.js';
import { LocalConcertHub } from '../src/concert/signaling.js';

const flush = () => new Promise((r) => setTimeout(r, 5));

function fakeMic() {
  let calls = 0;
  let stopped = 0;
  const getUserMedia = async () => {
    calls++;
    const track = { kind: 'audio', stop: () => void stopped++ } as unknown as MediaStreamTrack;
    return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  };
  return { getUserMedia, calls: () => calls, stopped: () => stopped };
}

function setup(overrides: Partial<typeof DEFAULT_CONFIG> = {}) {
  let t = 1000;
  const hub = new LocalConcertHub({ ...DEFAULT_CONFIG, concertMode: true, ...overrides }, 'room1', { now: () => t++, disconnectGraceMs: 20 });
  const phone = (id: string, name: string) => {
    const mic = fakeMic();
    const adapter = new LocalMediaAdapter((producer) => void hub.registerProducer(producer));
    const media = new ConcertMediaService(adapter, mic.getUserMedia);
    const client = new ParticipantClient(hub.client('participant'), media, { participantId: id, roomId: 'room1', name });
    return { client, media, adapter, mic };
  };
  const dj = new DjClient(hub.client('dj'), 'room1', { now: () => t++ });
  return { hub, phone, dj };
}

test('flujo completo: READY → PREPARE → PREPARED → GO LIVE → MUTE → UNMUTE → END', async () => {
  const { hub, phone, dj } = setup();
  await dj.connect();
  const ana = phone('ana', 'Ana');
  assert.equal(await ana.client.connect(), 'CONNECTED');
  await ana.client.ready();
  await flush();
  assert.equal(ana.client.state, 'READY');
  assert.equal(ana.mic.calls(), 0, 'READY no pide micrófono');
  assert.equal(dj.readyPage().total, 1);

  await dj.prepare('ana');
  await flush();
  await flush();
  assert.equal(ana.client.state, 'PREPARED');
  assert.equal(ana.media.state, 'PREPARED');
  assert.equal(ana.mic.calls(), 1);
  assert.equal(hub.producers.size, 1);
  const producer = [...hub.producers.values()][0]!;
  assert.equal(producer.paused, true);
  assert.equal(dj.participant('ana')?.state, 'PREPARED');
  assert.equal(dj.participant('ana')?.slotId, 'MIC_A');

  await dj.goLive('ana');
  await flush();
  assert.equal(ana.client.state, 'LIVE');
  assert.equal(ana.media.state, 'LIVE');
  assert.equal(producer.paused, false);
  assert.ok(dj.log.some((e) => e.text.includes('EN VIVO')));

  await dj.mute('ana');
  await flush();
  assert.equal(ana.media.state, 'MUTED');
  assert.equal(producer.paused, true);
  await dj.unmute('ana');
  await flush();
  assert.equal(ana.media.state, 'LIVE');

  await dj.end('ana');
  await flush();
  assert.equal(ana.client.state, 'READY');
  assert.equal(ana.media.state, 'IDLE', 'END cierra el producer y detiene la pista');
  assert.equal(ana.mic.stopped(), 1);
  assert.equal(producer.closed, true);
  assert.equal(hub.producers.size, 0);
  assert.equal(hub.room.metrics().live, 0);
});

test('el rol lo fija el servidor: un participante no puede ejecutar órdenes del DJ aunque envíe el evento', async () => {
  const { hub, phone, dj } = setup();
  await dj.connect();
  const ana = phone('ana', 'Ana');
  const bob = phone('bob', 'Bob');
  await ana.client.connect();
  await bob.client.connect();
  await ana.client.ready();
  await assert.rejects(bob.client.signaling.request(EVENTS.prepare, { participantId: 'ana', role: 'dj' }), /DJ|administrador/);
  await assert.rejects(bob.client.signaling.request(EVENTS.list, {}), /DJ|administrador/);
  assert.equal(hub.room.metrics().preparing, 0);
});

test('límites: MAX_PREPARED_MICS y MAX_LIVE_MICS se respetan y el DJ recibe el error', async () => {
  const { phone, dj } = setup({ maxLiveMics: 1, maxPreparedMics: 2 });
  await dj.connect();
  const phones = ['a', 'b', 'c'].map((id) => phone(id, id.toUpperCase()));
  for (const p of phones) {
    await p.client.connect();
    await p.client.ready();
  }
  await dj.prepare('a');
  await dj.prepare('b');
  await flush();
  await flush();
  await assert.rejects(dj.prepare('c'), /preparados/);
  await dj.goLive('a');
  await flush();
  await assert.rejects(dj.goLive('b'), /en vivo/);
  assert.ok(dj.log.some((e) => e.kind === 'error'));
});

test('APAGAR MI MICRÓFONO: el participante siempre puede cortar y vuelve a READY', async () => {
  const { hub, phone, dj } = setup();
  await dj.connect();
  const ana = phone('ana', 'Ana');
  await ana.client.connect();
  await ana.client.ready();
  await dj.prepare('ana');
  await flush();
  await flush();
  await dj.goLive('ana');
  await flush();
  assert.equal(ana.media.state, 'LIVE');
  await ana.client.stopMyMic();
  await flush();
  assert.equal(ana.media.state, 'IDLE');
  assert.equal(ana.client.state, 'READY');
  assert.equal(hub.room.metrics().live, 0);
  assert.equal(dj.slots.find((s) => s.slotId === 'MIC_A')?.state, 'EMPTY');
});

test('fallo de permiso en el teléfono: el DJ ve prepare-failed y el participante vuelve a READY', async () => {
  const { hub, dj } = setup();
  await dj.connect();
  const adapter = new LocalMediaAdapter((p) => void hub.registerProducer(p));
  const media = new ConcertMediaService(adapter, async () => {
    throw new Error('NotAllowedError');
  });
  const client = new ParticipantClient(hub.client('participant'), media, { participantId: 'ana', roomId: 'room1', name: 'Ana' });
  await client.connect();
  await client.ready();
  await dj.prepare('ana');
  await flush();
  await flush();
  assert.equal(client.state, 'READY');
  assert.match(client.error ?? '', /micrófono/);
  assert.ok(dj.log.some((e) => e.text.includes('permissionDenied')));
  assert.equal(dj.slots.find((s) => s.slotId === 'MIC_A')?.state, 'EMPTY');
});

test('reconexión: el participante conserva su participantId y su sitio READY', async () => {
  const { hub, phone, dj } = setup();
  await dj.connect();
  const ana = phone('ana', 'Ana');
  await ana.client.connect();
  await ana.client.ready();
  await flush();
  const readyAt = hub.room.participants.get('ana')?.timestampReady;
  ana.client.signaling.disconnect();
  await flush();
  assert.equal(ana.client.state, 'DISCONNECTED');
  assert.equal(await ana.client.connect(), 'READY');
  assert.equal(hub.room.participants.get('ana')?.timestampReady, readyAt, 'no pierde la antigüedad');
  assert.equal(dj.readyPage().total, 1);
});

test('lista READY del DJ: búsqueda, orden por antigüedad y paginación', async () => {
  const { phone, dj } = setup();
  await dj.connect();
  for (const [i, name] of ['Carla', 'Beto', 'Ana', 'Carlos'].entries()) {
    const p = phone(`p${i}`, name);
    await p.client.connect();
    await p.client.ready();
  }
  await flush();
  assert.deepEqual(
    dj.readyPage().items.map((p) => p.name),
    ['Carla', 'Beto', 'Ana', 'Carlos'],
  );
  assert.deepEqual(
    dj.readyPage('carl').items.map((p) => p.name),
    ['Carla', 'Carlos'],
  );
  const page = dj.readyPage('', 1, 2);
  assert.equal(page.total, 4);
  assert.deepEqual(
    page.items.map((p) => p.name),
    ['Beto', 'Ana'],
  );
  const server = await dj.list({ state: 'READY', query: 'an', limit: 1 });
  assert.equal(server.total, 1);
  assert.equal(server.items[0]?.name, 'Ana');
});

test('Concert Mode desactivado: join rechazado', async () => {
  const { phone } = setup({ concertMode: false });
  const ana = phone('ana', 'Ana');
  await assert.rejects(ana.client.connect(), /desactivado/);
});
