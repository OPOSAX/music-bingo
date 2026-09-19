/**
 * Manejadores Socket.IO del Concert Mode para el servidor de B-Talk. Es código de servidor
 * escrito contra una interfaz mínima de socket, así que se prueba en Node sin Socket.IO y se
 * puede pegar tal cual en B-Talk (`attachConcertHandlers(room, socket, role)`).
 *
 * Seguridad: el rol lo decide el servidor (token/sesión de B-Talk); nunca se lee del cliente.
 */

import { ConcertError, type ConcertRoom } from './concert-room.js';
import { EVENTS, OPERATOR_ROLES, type ConnectionQuality, type JoinAck, type JoinPayload, type ListRequest, type PreparedPayload, type PrepareFailedPayload, type Role } from './protocol.js';

type Ack = (response: unknown) => void;

export interface ServerSocketLike {
  readonly id: string;
  on(event: string, handler: (payload: any, ack?: Ack) => void): void;
  emit(event: string, payload: unknown): void;
}

export interface HandlerOptions {
  /** Parámetros de transporte (routerRtpCapabilities, WebRtcTransport) que B-Talk adjunta a la orden PREPARE. */
  transportParamsFor?: (participantId: string) => Promise<unknown> | unknown;
  log?: (message: string) => void;
}

function fail(ack: Ack | undefined, err: unknown): void {
  const code = err instanceof ConcertError ? err.code : 'internal';
  const message = err instanceof Error ? err.message : String(err);
  ack?.({ ok: false, code, message });
}

function ok(ack: Ack | undefined, data: unknown = {}): void {
  ack?.({ ok: true, ...(typeof data === 'object' && data ? data : {}) });
}

/** Registra todos los eventos concert:* en un socket. Devuelve una función para desconectarlo del room. */
export function attachConcertHandlers(room: ConcertRoom, socket: ServerSocketLike, role: Role, options: HandlerOptions = {}): () => void {
  const log = options.log ?? (() => undefined);
  const isOperator = OPERATOR_ROLES.includes(role);
  const me = () => room.participantBySocket(socket.id);

  socket.on(EVENTS.join, (payload: JoinPayload, ack) => {
    try {
      if (!room.config.concertMode) {
        ack?.({ ok: false, code: 'disabled', message: 'Concert Mode desactivado' } satisfies Partial<JoinAck> & { ok: false; code: string; message: string });
        return;
      }
      if (isOperator) {
        // El DJ/admin no es un participante: no ocupa sitio en la lista ni cuenta en las métricas.
        const response: JoinAck & { ok: true } = { ok: true, participantId: `op:${socket.id}`, state: 'CONNECTED', concertMode: true };
        ack?.(response);
        socket.emit(EVENTS.metrics, room.metrics());
        return;
      }
      const meta = { ...payload.meta, participantId: payload.participantId };
      const result = room.join(socket.id, meta);
      const response: JoinAck & { ok: true } = { ok: true, participantId: result.participantId, state: result.state, concertMode: true };
      ack?.(response);
    } catch (err) {
      fail(ack, err);
    }
  });

  socket.on(EVENTS.ready, (_payload, ack) => {
    try {
      const p = me();
      if (!p) throw new ConcertError('not-joined', 'Primero concert:join');
      room.ready(p.participantId);
      ok(ack, { state: 'READY' });
    } catch (err) {
      fail(ack, err);
    }
  });

  socket.on(EVENTS.leave, (_payload, ack) => {
    const p = me();
    if (!p) return ok(ack);
    room.leave(p.participantId).then(() => ok(ack), (err) => fail(ack, err));
  });

  socket.on(EVENTS.stopMyMic, (_payload, ack) => {
    const p = me();
    if (!p) return ok(ack);
    room.stopMyMic(p.participantId).then(() => ok(ack), (err) => fail(ack, err));
  });

  socket.on('concert:heartbeat', (payload: { quality?: ConnectionQuality } | undefined) => {
    const p = me();
    if (p) room.heartbeat(p.participantId, payload?.quality);
  });

  socket.on(EVENTS.prepared, (payload: PreparedPayload, ack) => {
    try {
      const p = me();
      if (!p) throw new ConcertError('not-joined', 'Primero concert:join');
      // El servidor ya conoce el producer: lo registró el handler de produce de B-Talk con su appData.
      room.prepared(p.participantId, payload.producerId);
      ok(ack);
    } catch (err) {
      fail(ack, err);
    }
  });

  socket.on(EVENTS.prepareFailed, (payload: PrepareFailedPayload, ack) => {
    const p = me();
    if (!p) return ok(ack);
    room.prepareFailed(p.participantId, payload.reason, payload.detail).then(() => ok(ack), (err) => fail(ack, err));
  });

  // ----- Operador (DJ/admin). `role` viene del servidor, nunca del payload. -----
  const operatorOnly = (ack: Ack | undefined): boolean => {
    if (isOperator) return true;
    fail(ack, new ConcertError('forbidden', 'Solo el DJ o un administrador pueden hacer esto'));
    return false;
  };

  socket.on(EVENTS.prepare, (payload: { participantId: string; slotId?: string }, ack) => {
    if (!operatorOnly(ack)) return;
    (async () => {
      const transport = options.transportParamsFor ? await options.transportParamsFor(payload.participantId) : undefined;
      const slot = room.prepare(role, payload.participantId, payload.slotId, transport);
      log(`PREPARE ${payload.participantId} → ${slot.slotId}`);
      ok(ack, { slot });
    })().catch((err) => fail(ack, err));
  });

  const operatorAction = (event: string, fn: (participantId: string) => Promise<void>) => {
    socket.on(event, (payload: { participantId: string }, ack) => {
      if (!operatorOnly(ack)) return;
      fn(payload.participantId).then(() => ok(ack), (err) => fail(ack, err));
    });
  };
  operatorAction(EVENTS.goLive, (id) => room.goLive(role, id));
  operatorAction(EVENTS.mute, (id) => room.mute(role, id));
  operatorAction(EVENTS.unmute, (id) => room.unmute(role, id));
  operatorAction(EVENTS.end, (id) => room.end(role, id));

  socket.on(EVENTS.list, (payload: ListRequest | undefined, ack) => {
    if (!operatorOnly(ack)) return;
    ok(ack, room.list(payload ?? {}));
  });

  socket.on(EVENTS.metrics, (_payload, ack) => {
    if (!operatorOnly(ack)) return;
    ok(ack, room.metrics());
  });

  return () => room.disconnect(socket.id);
}

/**
 * Hook para el handler `consume` de B-Talk: antes de crear un consumer sobre un producer con
 * appData.source === 'crowd-mic', llamar a esta función con el rol del socket que pide consumir.
 */
export function assertCanConsume(room: ConcertRoom, role: Role, producerAppData: unknown): void {
  if (!room.canConsume(role, producerAppData)) throw new ConcertError('forbidden', 'Este rol no puede consumir micrófonos del público');
}
