/** Clasificación de calidad de conexión y lectura de estadísticas WebRTC (puro, sin DOM). */

import type { ConnectionQuality } from './protocol.js';

export interface LinkStats {
  rttMs?: number;
  jitterMs?: number;
  lossPct?: number;
}

export function classifyQuality(stats: LinkStats): ConnectionQuality {
  if (stats.rttMs === undefined && stats.jitterMs === undefined && stats.lossPct === undefined) return 'UNKNOWN';
  const rtt = stats.rttMs ?? 0;
  const jitter = stats.jitterMs ?? 0;
  const loss = stats.lossPct ?? 0;
  if (rtt > 400 || jitter > 60 || loss > 8) return 'BAD';
  if (rtt > 180 || jitter > 30 || loss > 2) return 'FAIR';
  return 'GOOD';
}

/** Extrae RTT/jitter/pérdidas de un RTCStatsReport (candidate-pair + remote-inbound-rtp de audio). */
export function readLinkStats(report: Iterable<Record<string, unknown>>): LinkStats {
  const out: LinkStats = {};
  let sent = 0;
  let lost = 0;
  for (const s of report) {
    if (s.type === 'candidate-pair' && (s.nominated === true || s.state === 'succeeded') && typeof s.currentRoundTripTime === 'number') out.rttMs = s.currentRoundTripTime * 1000;
    if (s.type === 'remote-inbound-rtp' && s.kind === 'audio') {
      if (typeof s.jitter === 'number') out.jitterMs = s.jitter * 1000;
      if (typeof s.roundTripTime === 'number' && out.rttMs === undefined) out.rttMs = s.roundTripTime * 1000;
      if (typeof s.packetsLost === 'number') lost += s.packetsLost;
    }
    if (s.type === 'outbound-rtp' && s.kind === 'audio' && typeof s.packetsSent === 'number') sent += s.packetsSent;
    if (s.type === 'inbound-rtp' && s.kind === 'audio') {
      if (typeof s.jitter === 'number') out.jitterMs = s.jitter * 1000;
      if (typeof s.packetsLost === 'number') lost += s.packetsLost;
      if (typeof s.packetsReceived === 'number') sent += s.packetsReceived + (typeof s.packetsLost === 'number' ? s.packetsLost : 0);
    }
  }
  if (sent > 0) out.lossPct = Math.max(0, Math.min(100, (lost / sent) * 100));
  return out;
}

/** Calcula deltas entre dos lecturas para que la pérdida refleje el último intervalo, no el histórico. */
export class LinkStatsTracker {
  private last: { sent: number; lost: number } | null = null;
  update(report: Iterable<Record<string, unknown>>): LinkStats {
    let sent = 0;
    let lost = 0;
    const base = readLinkStats(report);
    for (const s of report) {
      if ((s.type === 'outbound-rtp' || s.type === 'inbound-rtp') && s.kind === 'audio') {
        if (typeof s.packetsSent === 'number') sent += s.packetsSent;
        if (typeof s.packetsReceived === 'number') sent += s.packetsReceived;
      }
      if ((s.type === 'remote-inbound-rtp' || s.type === 'inbound-rtp') && s.kind === 'audio' && typeof s.packetsLost === 'number') lost += s.packetsLost;
    }
    if (this.last && sent > this.last.sent) {
      const dSent = sent - this.last.sent + Math.max(0, lost - this.last.lost);
      base.lossPct = dSent > 0 ? Math.max(0, Math.min(100, ((lost - this.last.lost) / dSent) * 100)) : 0;
    }
    this.last = { sent, lost };
    return base;
  }
}
