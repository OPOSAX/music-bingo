/**
 * Señalización del cliente Concert Mode. Dos implementaciones con la misma interfaz:
 *  - SocketIoSignaling: envuelve un socket de Socket.IO (B-Talk).
 *  - LocalSignaling: hub en memoria sobre ConcertRoom + attachConcertHandlers, para pruebas y demo.
 */

import { ConcertRoom, type MediaControl } from './concert-room.js';
import { LocalProducer } from './media-service.js';
import { attachConcertHandlers, type ServerSocketLike } from './server-handlers.js';
import type { ConcertConfig, Role } from './protocol.js';

export interface AckResponse {
  ok: boolean;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

export interface ConcertSignaling {
  readonly connected: boolean;
  connect(): Promise<void>;
  disconnect(): void;
  /** Envía un evento con acuse de recibo. Rechaza si el servidor responde ok:false. */
  request<T = Record<string, unknown>>(event: string, payload?: unknown): Promise<T & AckResponse>;
  /** Envía sin esperar respuesta. */
  send(event: string, payload?: unknown): void;
  on(event: string, handler: (payload: any) => void): () => void;
  onConnection(handler: (connected: boolean) => void): () => void;
}

export class SignalingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/* ---------------- Socket.IO ---------------- */

/** Subconjunto del cliente de Socket.IO que usamos. */
export interface SocketLike {
  connected: boolean;
  connect(): void;
  disconnect(): void;
  emit(event: string, payload: unknown, ack?: (response: unknown) => void): void;
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler: (...args: any[]) => void): void;
}

export class SocketIoSignaling implements ConcertSignaling {
  private readonly connectionHandlers = new Set<(connected: boolean) => void>();
  constructor(
    private readonly socket: SocketLike,
    private readonly timeoutMs = 10_000,
  ) {
    socket.on('connect', () => this.connectionHandlers.forEach((h) => h(true)));
    socket.on('disconnect', () => this.connectionHandlers.forEach((h) => h(false)));
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  connect(): Promise<void> {
    if (this.socket.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new SignalingError('timeout', 'No se pudo conectar con el servidor')), this.timeoutMs);
      const onConnect = () => {
        clearTimeout(timer);
        this.socket.off('connect', onConnect);
        resolve();
      };
      this.socket.on('connect', onConnect);
      this.socket.connect();
    });
  }

  disconnect(): void {
    this.socket.disconnect();
  }

  request<T = Record<string, unknown>>(event: string, payload: unknown = {}): Promise<T & AckResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new SignalingError('timeout', `Sin respuesta a ${event}`)), this.timeoutMs);
      this.socket.emit(event, payload, (response: unknown) => {
        clearTimeout(timer);
        const r = (response ?? {}) as T & AckResponse;
        if (r.ok === false) reject(new SignalingError(r.code ?? 'error', r.message ?? 'Error del servidor'));
        else resolve(r);
      });
    });
  }

  send(event: string, payload: unknown = {}): void {
    this.socket.emit(event, payload);
  }

  on(event: string, handler: (payload: any) => void): () => void {
    this.socket.on(event, handler);
    return () => this.socket.off(event, handler);
  }

  onConnection(handler: (connected: boolean) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }
}

/**
 * Carga el cliente de Socket.IO que sirve el propio servidor de B-Talk (`/socket.io/socket.io.esm.min.js`)
 * y abre el socket con el token de sesión. El rol NO viaja aquí: lo resuelve el servidor a partir del token.
 */
export async function connectBTalk(btalkUrl: string, auth: { token?: string; roomId: string }): Promise<SocketIoSignaling> {
  const base = btalkUrl.replace(/\/$/, '');
  const mod = (await import(/* @vite-ignore */ `${base}/socket.io/socket.io.esm.min.js`)) as { io: (url: string, opts: Record<string, unknown>) => SocketLike };
  const socket = mod.io(base, { autoConnect: false, transports: ['websocket'], auth, reconnection: true, reconnectionDelayMax: 5000 });
  return new SocketIoSignaling(socket);
}

/* ---------------- Hub local (pruebas y demo) ---------------- */

class LocalServerSocket implements ServerSocketLike {
  private readonly handlers = new Map<string, (payload: any, ack?: (r: unknown) => void) => void>();
  constructor(
    readonly id: string,
    private readonly client: LocalSignaling,
  ) {}
  on(event: string, handler: (payload: any, ack?: (r: unknown) => void) => void): void {
    this.handlers.set(event, handler);
  }
  emit(event: string, payload: unknown): void {
    this.client.deliver(event, payload);
  }
  dispatch(event: string, payload: unknown, ack?: (r: unknown) => void): void {
    const handler = this.handlers.get(event);
    if (!handler) {
      ack?.({ ok: false, code: 'unknown-event', message: `Evento desconocido ${event}` });
      return;
    }
    handler(payload, ack);
  }
}

/** Servidor en memoria: un ConcertRoom, sockets locales y control de "producers" simulados. */
export class LocalConcertHub {
  readonly room: ConcertRoom;
  readonly sockets = new Map<string, { socket: LocalServerSocket; role: Role; detach: () => void }>();
  readonly producers = new Map<string, LocalProducer>();
  private seq = 0;
  /** Función que asigna el rol a cada conexión: simula la autenticación del servidor. */
  constructor(
    config: ConcertConfig,
    readonly roomId = 'demo',
    options: { disconnectGraceMs?: number; now?: () => number } = {},
  ) {
    const media: MediaControl = {
      pauseProducer: (id) => this.producers.get(id)?.pause(),
      resumeProducer: (id) => this.producers.get(id)?.resume(),
      closeProducer: (id) => {
        this.producers.get(id)?.close();
        this.producers.delete(id);
      },
    };
    this.room = new ConcertRoom(
      roomId,
      config,
      media,
      {
        toParticipant: (participantId, event, payload) => {
          for (const entry of this.sockets.values()) {
            const p = this.room.participantBySocket(entry.socket.id);
            if (p?.participantId === participantId) entry.socket.emit(event, payload);
          }
        },
        toOperators: (event, payload) => {
          for (const entry of this.sockets.values()) if (entry.role === 'dj' || entry.role === 'admin') entry.socket.emit(event, payload);
        },
      },
      { disconnectGraceMs: options.disconnectGraceMs ?? 30_000, ...(options.now ? { now: options.now } : {}) },
    );
  }

  /** Crea un cliente conectado con el rol que decide el "servidor" (nunca el cliente). */
  client(role: Role): LocalSignaling {
    return new LocalSignaling(this, role);
  }

  /** Simula el handler `produce` de B-Talk: valida appData con el room y registra el producer. */
  registerProducer(producer: LocalProducer): boolean {
    const accepted = this.room.registerProducer(producer.appData.participantId, producer.id, producer.appData);
    if (accepted) this.producers.set(producer.id, producer);
    else producer.close();
    return accepted;
  }

  /** @internal */
  open(client: LocalSignaling, role: Role): LocalServerSocket {
    const socket = new LocalServerSocket(`sock-${++this.seq}`, client);
    const detach = attachConcertHandlers(this.room, socket, role);
    this.sockets.set(socket.id, { socket, role, detach });
    return socket;
  }

  /** @internal */
  close(socket: LocalServerSocket): void {
    const entry = this.sockets.get(socket.id);
    if (!entry) return;
    entry.detach();
    this.sockets.delete(socket.id);
  }
}

export class LocalSignaling implements ConcertSignaling {
  private socket: LocalServerSocket | null = null;
  private readonly handlers = new Map<string, Set<(payload: any) => void>>();
  private readonly connectionHandlers = new Set<(connected: boolean) => void>();
  constructor(
    private readonly hub: LocalConcertHub,
    private readonly role: Role,
  ) {}

  get connected(): boolean {
    return this.socket !== null;
  }

  async connect(): Promise<void> {
    if (this.socket) return;
    this.socket = this.hub.open(this, this.role);
    this.connectionHandlers.forEach((h) => h(true));
  }

  disconnect(): void {
    if (!this.socket) return;
    this.hub.close(this.socket);
    this.socket = null;
    this.connectionHandlers.forEach((h) => h(false));
  }

  request<T = Record<string, unknown>>(event: string, payload: unknown = {}): Promise<T & AckResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new SignalingError('disconnected', 'Sin conexión'));
      this.socket.dispatch(event, payload, (response) => {
        const r = (response ?? {}) as T & AckResponse;
        if (r.ok === false) reject(new SignalingError(r.code ?? 'error', r.message ?? 'Error'));
        else resolve(r);
      });
    });
  }

  send(event: string, payload: unknown = {}): void {
    this.socket?.dispatch(event, payload);
  }

  on(event: string, handler: (payload: any) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => set?.delete(handler);
  }

  onConnection(handler: (connected: boolean) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  /** @internal */
  deliver(event: string, payload: unknown): void {
    // Asíncrono como en la red real: evita reentradas dentro de los handlers del room.
    queueMicrotask(() => this.handlers.get(event)?.forEach((h) => h(payload)));
  }
}
