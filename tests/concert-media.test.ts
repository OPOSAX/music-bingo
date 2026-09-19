import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConcertMediaService, LocalMediaAdapter, MediaServiceError, micConstraints, opusOptions } from '../src/concert/media-service.js';

/** Micrófono falso: cuenta llamadas a getUserMedia y detenciones de pista. */
function fakeMic() {
  const calls: MediaStreamConstraints[] = [];
  let stopped = 0;
  const getUserMedia = async (c: MediaStreamConstraints) => {
    calls.push(c);
    const track = { kind: 'audio', stop: () => void stopped++ } as unknown as MediaStreamTrack;
    return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  };
  return { getUserMedia, calls, stopped: () => stopped };
}

const identity = { participantId: 'p1', roomId: 'room1' };

test('perfiles: SING desactiva NS/AGC del navegador y usa más bitrate; TALK activa DTX', () => {
  const sing = micConstraints('SING').audio as MediaTrackConstraints;
  const talk = micConstraints('TALK', 'dev-1').audio as MediaTrackConstraints;
  assert.equal(sing.echoCancellation, true);
  assert.equal(sing.noiseSuppression, false);
  assert.equal(sing.autoGainControl, false);
  assert.equal(talk.noiseSuppression, true);
  assert.deepEqual(talk.deviceId, { exact: 'dev-1' });
  assert.equal(opusOptions('SING').codecOptions.opusDtx, false);
  assert.equal(opusOptions('TALK').codecOptions.opusDtx, true);
  assert.ok((opusOptions('SING').encodings[0]?.maxBitrate ?? 0) > (opusOptions('TALK').encodings[0]?.maxBitrate ?? 0));
});

test('READY no toca getUserMedia ni crea transporte: el servicio recién creado está IDLE', () => {
  const mic = fakeMic();
  const adapter = new LocalMediaAdapter();
  const service = new ConcertMediaService(adapter, mic.getUserMedia);
  assert.equal(service.state, 'IDLE');
  assert.equal(mic.calls.length, 0);
  assert.equal(adapter.transportsCreated, 0);
  assert.equal(adapter.producers.length, 0);
});

test('PREPARE crea un único transporte y un único producer en pausa; GO LIVE lo reanuda; END detiene la pista', async () => {
  const mic = fakeMic();
  const adapter = new LocalMediaAdapter();
  const service = new ConcertMediaService(adapter, mic.getUserMedia);
  const prepared = await service.prepare({ slotId: 'MIC_A', profile: 'SING' }, identity);
  assert.equal(service.state, 'PREPARED');
  assert.equal(mic.calls.length, 1);
  assert.equal(adapter.transportsCreated, 1);
  assert.equal(adapter.producers.length, 1);
  const producer = adapter.producers[0]!;
  assert.equal(producer.paused, true, 'el producer nace en pausa');
  assert.equal(prepared.producerId, producer.id);
  assert.equal(prepared.slotId, 'MIC_A');
  assert.deepEqual(producer.appData, { mediaType: 'audio', source: 'crowd-mic', participantId: 'p1', roomId: 'room1', slotId: 'MIC_A' });

  await service.goLive();
  assert.equal(service.state, 'LIVE');
  assert.equal(producer.paused, false);

  await service.mute();
  assert.equal(service.state, 'MUTED');
  assert.equal(producer.paused, true);
  await service.goLive();
  assert.equal(producer.paused, false);

  await service.stop();
  assert.equal(service.state, 'IDLE');
  assert.equal(producer.closed, true);
  assert.equal(adapter.transportOpen, false);
  assert.equal(mic.stopped(), 1, 'la pista del micrófono se detiene (se apaga el indicador del móvil)');
});

test('PREPARE con permiso denegado limpia todo y reporta permissionDenied', async () => {
  const adapter = new LocalMediaAdapter();
  const service = new ConcertMediaService(adapter, async () => {
    throw new Error('NotAllowedError');
  });
  await assert.rejects(service.prepare({ slotId: 'MIC_A', profile: 'SING' }, identity), (err: unknown) => err instanceof MediaServiceError && err.reason === 'permissionDenied');
  assert.equal(service.state, 'IDLE');
  assert.equal(adapter.transportsCreated, 0);
});

test('PREPARE con fallo de producer libera micrófono y transporte', async () => {
  const mic = fakeMic();
  const adapter = new LocalMediaAdapter();
  adapter.produce = async () => {
    throw new Error('boom');
  };
  const service = new ConcertMediaService(adapter, mic.getUserMedia);
  await assert.rejects(service.prepare({ slotId: 'MIC_A', profile: 'SING' }, identity), (err: unknown) => err instanceof MediaServiceError && err.reason === 'producerFailed');
  assert.equal(mic.stopped(), 1);
  assert.equal(adapter.transportOpen, false);
});

test('no se puede pasar a LIVE sin haber preparado', async () => {
  const service = new ConcertMediaService(new LocalMediaAdapter(), fakeMic().getUserMedia);
  await assert.rejects(service.goLive(), /LIVE/);
});
