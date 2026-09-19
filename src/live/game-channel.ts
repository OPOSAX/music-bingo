/**
 * Plano de juego por Socket.IO: mismos mensajes que el canal ntfy (estado, pool, claim, cfg), pero
 * transportados por el servidor Live, que guarda el histórico para quien llega tarde.
 */

import type { SyncMessage } from '../sync.js';
import { parseSyncMessage } from '../sync.js';
import { LIVE_EVENTS } from './protocol.js';
import { liveSession, type LiveLink } from './session.js';

export interface GameSubscription {
  close(): void;
}

/** Publica un mensaje del plano de juego. El anfitrión publica estado/pool/cfg; los jugadores solo peticiones de tarjeta. */
export async function publishViaSocket(link: LiveLink, message: unknown, token?: string): Promise<boolean> {
  const session = liveSession(link, token ? { token } : {});
  try {
    await session.connect();
    const raw = JSON.stringify(message);
    const data = message as { k?: string };
    await session.request(data.k === 'claim' ? LIVE_EVENTS.gameClaim : LIVE_EVENTS.gamePublish, { message: raw });
    return true;
  } catch {
    return false;
  }
}

/** Suscripción al plano de juego: entrega el histórico al unirse (y al reconectar) y luego cada mensaje nuevo. */
export function subscribeViaSocket(link: LiveLink, onMessage: (message: SyncMessage | { k: 'cfg'; raw: string }) => void, onStatus?: (online: boolean) => void, token?: string): GameSubscription {
  const session = liveSession(link, token ? { token } : {});
  let closed = false;
  let latestState = 0;
  const offs: (() => void)[] = [];
  const deliver = (raw: string) => {
    let data: { k?: string };
    try {
      data = JSON.parse(raw) as { k?: string };
    } catch {
      return;
    }
    if (data.k === 'cfg') {
      onMessage({ k: 'cfg', raw });
      return;
    }
    const msg = parseSyncMessage(raw);
    if (!msg) return;
    if (msg.k === 'state') {
      if (msg.state.t < latestState) return;
      latestState = msg.state.t;
    }
    onMessage(msg);
  };
  void session
    .connect()
    .then((ack) => {
      if (closed) return;
      offs.push(session.onJoin((again) => again.history.forEach(deliver)));
      offs.push(session.on(LIVE_EVENTS.gameMessage, (p: { message: string }) => deliver(p.message)));
      offs.push(session.onState((state) => onStatus?.(state === 'LIVE')));
      onStatus?.(true);
      ack.history.forEach(deliver);
    })
    .catch(() => onStatus?.(false));
  return {
    close: () => {
      closed = true;
      offs.forEach((off) => off());
    },
  };
}
