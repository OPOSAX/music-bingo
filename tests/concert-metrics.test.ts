import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LinkStatsTracker, classifyQuality, readLinkStats } from '../src/concert/metrics.js';

test('classifyQuality: umbrales de RTT, jitter y pérdidas', () => {
  assert.equal(classifyQuality({}), 'UNKNOWN');
  assert.equal(classifyQuality({ rttMs: 60, jitterMs: 10, lossPct: 0 }), 'GOOD');
  assert.equal(classifyQuality({ rttMs: 250 }), 'FAIR');
  assert.equal(classifyQuality({ jitterMs: 45 }), 'FAIR');
  assert.equal(classifyQuality({ lossPct: 12 }), 'BAD');
  assert.equal(classifyQuality({ rttMs: 500 }), 'BAD');
});

test('readLinkStats extrae RTT/jitter/pérdidas de un informe WebRTC', () => {
  const report = [
    { type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.12 },
    { type: 'outbound-rtp', kind: 'audio', packetsSent: 1000 },
    { type: 'remote-inbound-rtp', kind: 'audio', jitter: 0.02, packetsLost: 10 },
  ];
  const s = readLinkStats(report);
  assert.equal(s.rttMs, 120);
  assert.equal(s.jitterMs, 20);
  assert.equal(s.lossPct, 1);
  assert.equal(classifyQuality(s), 'GOOD');
});

test('LinkStatsTracker calcula la pérdida del último intervalo', () => {
  const tracker = new LinkStatsTracker();
  tracker.update([
    { type: 'outbound-rtp', kind: 'audio', packetsSent: 1000 },
    { type: 'remote-inbound-rtp', kind: 'audio', packetsLost: 100 },
  ]);
  const s = tracker.update([
    { type: 'outbound-rtp', kind: 'audio', packetsSent: 1100 },
    { type: 'remote-inbound-rtp', kind: 'audio', packetsLost: 100 },
  ]);
  assert.equal(s.lossPct, 0, 'sin pérdidas nuevas en el intervalo');
});
