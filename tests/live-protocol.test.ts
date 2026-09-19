import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LIVE_EVENTS, REACTIONS, liveRoomId } from '../src/live/protocol.js';

test('la sala WebRTC se deriva del evento sin intervención del jugador', () => {
  assert.equal(liveRoomId('event_89382'), 'bingo-event_89382');
  assert.equal(liveRoomId('MTNVRW'), 'bingo-MTNVRW');
});

test('plano de vídeo y plano de juego usan prefijos distintos', () => {
  const media = ['rtpCapabilities', 'createTransport', 'connectTransport', 'produce', 'consume', 'start', 'stop'] as const;
  const game = ['gamePublish', 'gameClaim', 'gameMessage'] as const;
  for (const k of media) assert.ok(LIVE_EVENTS[k].startsWith('live:'), k);
  for (const k of game) assert.ok(LIVE_EVENTS[k].startsWith('game:'), k);
  assert.equal(new Set(Object.values(LIVE_EVENTS)).size, Object.values(LIVE_EVENTS).length, 'sin eventos duplicados');
});

test('reacciones permitidas', () => {
  assert.deepEqual([...REACTIONS], ['❤️', '👏', '🔥', '🍻', '🎉']);
});
