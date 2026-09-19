/** Comprobaciones del módulo Live sin mediasoup ni red (requiere `npm run build` en la raíz). */
import assert from 'node:assert/strict';
import { createLiveState, iceServersFromEnv, validateBingo } from '../live.mjs';
import { generateCard, playOrder } from '../../public/js/bingo.js';

// ICE: sin variables → vacío; con TURN_SECRET → credencial temporal HMAC; con usuario fijo → tal cual.
assert.deepEqual(iceServersFromEnv({}), []);
const turn = iceServersFromEnv({ TURN_SERVER_URL: 'turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349', TURN_SECRET: 's3cret' }, 600);
assert.equal(turn.length, 1);
assert.equal(turn[0].urls.length, 2);
assert.match(turn[0].username, /^\d+:bingo$/);
assert.ok(turn[0].credential.length > 10);
const fixed = iceServersFromEnv({ STUN_SERVER_URL: 'stun:stun.l.google.com:19302', TURN_SERVER_URL: 'turn:t', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' });
assert.deepEqual(fixed[1], { urls: ['turn:t'], username: 'u', credential: 'p' });

// Validación de bingo: el servidor regenera la tarjeta y la evalúa con las canciones cantadas.
const live = createLiveState();
const config = { seed: 'TEST42', gridSize: 3, freeCenter: false, cardCount: 5, snippetSeconds: 20, startMode: 'random' };
live.game.cfg = JSON.stringify({ k: 'cfg', seed: 'TEST42', gridSize: 3, freeCenter: false, cardCount: 5, poolSize: 20, topic: 't', title: 'Test' });
assert.deepEqual(validateBingo(live, { seed: 'TEST42', index: 0, kind: 'full' }), { valid: null }, 'sin estado publicado no se puede comprobar');
const card = generateCard(config, 20, 2);
const order = playOrder(config, 20);
const state = (called) => JSON.stringify({ v: 1, seed: 'TEST42', called, revealed: true, autoMark: 'played', t: Date.now() });
live.game.state = state(order.slice(0, 3));
assert.equal(validateBingo(live, { seed: 'TEST42', index: 2, kind: 'full' }).valid, false, 'con 3 canciones no hay bingo');
live.game.state = state(card.cells.slice(0, 3)); // primera fila completa
const line = validateBingo(live, { seed: 'TEST42', index: 2, kind: 'line' });
assert.equal(line.valid, true, 'línea válida');
assert.equal(validateBingo(live, { seed: 'TEST42', index: 2, kind: 'full' }).valid, false, 'aún no es bingo');
live.game.state = state(card.cells.filter((c) => c !== null));
const full = validateBingo(live, { seed: 'TEST42', index: 2, kind: 'full' });
assert.equal(full.valid, true, 'bingo válido');
assert.equal(full.serverStatus, 'full');
assert.equal(validateBingo(live, { seed: 'TEST42', index: 99, kind: 'full' }).valid, false, 'tarjeta inexistente');
assert.equal(validateBingo(live, { seed: 'OTRA', index: 2, kind: 'full' }).valid, null, 'otra partida');
console.log('unit OK');
