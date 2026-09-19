/**
 * Lógica de sala de CONCERT MODE, con el servidor como autoridad.
 * No depende de Socket.IO ni de mediasoup: B-Talk la envuelve con sus sockets y sus producers.
 */

import {
  CONSUMER_ROLES,
  OPERATOR_ROLES,
  SLOT_STATES,
  canTransition,
  isCrowdMicAppData,
  slotIds,
  type ConcertConfig,
  type ConcertMetrics,
  type ConnectionQuality,
  type ListRequest,
  type ListResponse,
  type ParticipantInfo,
  type PrepareOrder,
  type ParticipantMeta,
  type ParticipantState,
  type PrepareFailureReason,
  type Role,
  type SlotInfo,
  type SlotState,
} from './protocol.js';

/** Control de producers que aporta B-Talk (mediasoup). Pueden ser asíncronos. */
export interface MediaControl {
  pauseProducer(producerId: string): Promise<void> | void;
  resumeProducer(producerId: string): Promise<void> | void;
  closeProducer(producerId: string): Promise<void> | void;
}

/** Salida de eventos hacia los clientes (B-Talk los emite por Socket.IO). */
export interface RoomEmitter {
  /** Mensaje a un participante concreto (por participantId, no por socket.id). */
  toParticipant(participantId: string, event: string, payload: unknown): void;
  /** Mensaje a los operadores (dj/admin/audio-engine): deltas, métricas, errores. */
  toOperators(event: string, payload: unknown): void;
}

export class ConcertError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Participant extends Omit<ParticipantInfo, 'timestampReady' | 'slotId' | 'quality'> {
  timestampReady?: number | undefined;
  slotId?: string | undefined;
  quality?: ConnectionQuality | undefined;
  socketId?: string | undefined;
  producerId?: string | undefined;
  disconnectTimer?: ReturnType<typeof setTimeout> | undefined;
}

interface Slot extends Omit<SlotInfo, 'participantId' | 'producerId' | 'since'> {
  state: SlotState;
  participantId?: string | undefined;
  producerId?: string | undefined;
  since?: number | undefined;
}

/** Datos con los que un participante entra en la sala (la identidad persistente es opcional). */
export type JoinMeta = Omit<ParticipantMeta, 'roomId' | 'participantId'> & { participantId?: string | undefined };

export interface RoomOptions {
  /** Tiempo de gracia (ms) para que un READY reconecte sin perder su sitio. */
  disconnectGraceMs?: number;
  now?: () => number;
  idGenerator?: () => string;
}

function defaultId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class ConcertRoom {
  readonly participants = new Map<string, Participant>();
  readonly slots = new Map<string, Slot>();
  private readonly socketToParticipant = new Map<string, string>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly graceMs: number;
  nowPlaying: ConcertMetrics['nowPlaying'] = null;

  constructor(
    public readonly roomId: string,
    public readonly config: ConcertConfig,
    private readonly media: MediaControl,
    private readonly emitter: RoomEmitter,
    options: RoomOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.newId = options.idGenerator ?? defaultId;
    this.graceMs = options.disconnectGraceMs ?? 30_000;
    for (const id of slotIds(Math.max(config.maxLiveMics, config.maxPreparedMics))) this.slots.set(id, { slotId: id, state: 'EMPTY' });
  }

  /* ---------------- Participantes ---------------- */

  /** Entra (o reconecta) un participante. Devuelve su identidad persistente y su estado. */
  join(socketId: string, meta: JoinMeta): { participantId: string; state: ParticipantState } {
    const existing = meta.participantId ? this.participants.get(meta.participantId) : undefined;
    if (existing) {
      if (existing.socketId && existing.socketId !== socketId) this.socketToParticipant.delete(existing.socketId);
      if (existing.disconnectTimer) clearTimeout(existing.disconnectTimer);
      existing.disconnectTimer = undefined;
      existing.socketId = socketId;
      existing.lastSeen = this.now();
      existing.name = meta.name || existing.name;
      if (existing.state === 'DISCONNECTED') this.setState(existing, 'CONNECTED');
      this.socketToParticipant.set(socketId, existing.participantId);
      this.emitter.toParticipant(existing.participantId, 'concert:state', this.publicInfo(existing));
      return { participantId: existing.participantId, state: existing.state };
    }
    const participantId = meta.participantId ?? this.newId();
    const { participantId: _ignored, ...rest } = meta;
    const participant: Participant = {
      ...rest,
      participantId,
      roomId: this.roomId,
      state: 'CONNECTED',
      socketId,
      lastSeen: this.now(),
      quality: 'UNKNOWN',
    };
    this.participants.set(participantId, participant);
    this.socketToParticipant.set(socketId, participantId);
    this.emitter.toOperators('concert:participant-added', this.publicInfo(participant));
    return { participantId, state: participant.state };
  }

  participantBySocket(socketId: string): Participant | undefined {
    const id = this.socketToParticipant.get(socketId);
    return id ? this.participants.get(id) : undefined;
  }

  /** El socket se cae: READY conserva su sitio durante el periodo de gracia; PREPARED/LIVE avisan al DJ. */
  disconnect(socketId: string): void {
    const participant = this.participantBySocket(socketId);
    if (!participant) return;
    this.socketToParticipant.delete(socketId);
    participant.socketId = undefined;
    if (SLOT_STATES.includes(participant.state)) {
      this.emitter.toOperators('concert:error', { code: 'participant-lost', participantId: participant.participantId, slotId: participant.slotId, state: participant.state });
      participant.quality = 'BAD';
      this.emitter.toOperators('concert:participant-updated', this.publicInfo(participant));
    }
    participant.disconnectTimer = setTimeout(() => this.expire(participant.participantId), this.graceMs);
  }

  /** Pasado el periodo de gracia sin reconectar: se liberan recursos y se elimina. */
  private expire(participantId: string): void {
    const participant = this.participants.get(participantId);
    if (!participant || participant.socketId) return;
    void this.releaseSlot(participant);
    this.setState(participant, 'DISCONNECTED');
    this.participants.delete(participantId);
    this.emitter.toOperators('concert:participant-removed', { participantId });
  }

  heartbeat(participantId: string, quality?: ConnectionQuality): void {
    const p = this.participants.get(participantId);
    if (!p) return;
    p.lastSeen = this.now();
    if (quality && quality !== p.quality) {
      p.quality = quality;
      if (SLOT_STATES.includes(p.state)) this.emitter.toOperators('concert:participant-updated', this.publicInfo(p));
    }
  }

  ready(participantId: string): void {
    const p = this.require(participantId);
    if (p.state === 'READY') return;
    if (p.state === 'ERROR' || p.state === 'CONNECTED') {
      p.timestampReady = this.now();
      this.setState(p, 'READY');
      return;
    }
    throw new ConcertError('invalid-transition', `No se puede pasar a READY desde ${p.state}`);
  }

  /** Salir de la lista. Si estaba en un slot, se liberan los recursos. */
  async leave(participantId: string): Promise<void> {
    const p = this.require(participantId);
    await this.releaseSlot(p);
    p.timestampReady = undefined;
    if (p.state !== 'CONNECTED') this.setState(p, 'CONNECTED');
  }

  /* ---------------- Operaciones del DJ ---------------- */

  /** PREPARE: reserva un slot y ordena al teléfono que prepare su micrófono. */
  prepare(byRole: Role, participantId: string, slotId?: string, transport?: unknown): SlotInfo {
    this.requireOperator(byRole);
    const p = this.require(participantId);
    if (p.state !== 'READY') throw new ConcertError('not-ready', `El participante está en ${p.state}`);
    if (!p.socketId) throw new ConcertError('offline', 'El participante no está conectado');
    const inPreparation = [...this.slots.values()].filter((s) => s.state === 'PREPARING' || s.state === 'PREPARED').length;
    if (inPreparation >= this.config.maxPreparedMics) throw new ConcertError('max-prepared', `Ya hay ${inPreparation} micrófonos preparados (máximo ${this.config.maxPreparedMics})`);
    const slot = slotId ? this.slots.get(slotId) : [...this.slots.values()].find((s) => s.state === 'EMPTY');
    if (!slot) throw new ConcertError('no-slot', 'No hay slot disponible');
    if (slot.state !== 'EMPTY') throw new ConcertError('slot-busy', `El slot ${slot.slotId} está en ${slot.state}`);
    slot.state = 'PREPARING';
    slot.participantId = participantId;
    slot.since = this.now();
    p.slotId = slot.slotId;
    this.setState(p, 'PREPARING');
    const order: PrepareOrder = { slotId: slot.slotId, profile: this.config.audioProfile };
    if (transport !== undefined) order.transport = transport;
    this.emitter.toParticipant(participantId, 'concert:prepare', order);
    this.emitter.toOperators('concert:preparing', { participantId, slotId: slot.slotId });
    return this.publicSlot(slot);
  }

  /**
   * El teléfono ha creado su producer (en pausa). Se valida el appData y que no haya duplicados.
   * Devuelve false si el producer debe rechazarse (B-Talk lo cerrará).
   */
  registerProducer(participantId: string, producerId: string, appData: unknown): boolean {
    const p = this.participants.get(participantId);
    if (!p || p.state !== 'PREPARING' || !p.slotId) return false;
    if (!isCrowdMicAppData(appData) || appData.participantId !== participantId || appData.roomId !== this.roomId || appData.slotId !== p.slotId) return false;
    if (p.producerId && p.producerId !== producerId) return false; // nunca dos producers para el mismo participante/slot
    p.producerId = producerId;
    const slot = this.slots.get(p.slotId);
    if (slot) slot.producerId = producerId;
    return true;
  }

  prepared(participantId: string, producerId: string): void {
    const p = this.require(participantId);
    if (p.state !== 'PREPARING') throw new ConcertError('invalid-transition', `prepared recibido en ${p.state}`);
    if (p.producerId !== producerId) throw new ConcertError('unknown-producer', 'El producer no está registrado para este participante');
    const slot = this.requireSlot(p);
    slot.state = 'PREPARED';
    this.setState(p, 'PREPARED');
    this.emitter.toOperators('concert:prepared', { participantId, slotId: slot.slotId, producerId });
  }

  async prepareFailed(participantId: string, reason: PrepareFailureReason, detail?: string): Promise<void> {
    const p = this.require(participantId);
    if (p.state !== 'PREPARING') return;
    this.emitter.toOperators('concert:prepare-failed', { participantId, slotId: p.slotId, reason, detail });
    await this.releaseSlot(p);
    this.setState(p, 'ERROR');
    // Vuelve a READY automáticamente para que el DJ pueda reintentar.
    p.timestampReady = p.timestampReady ?? this.now();
    this.setState(p, 'READY');
  }

  /** GO LIVE: valida rol, participante, slot, producer y MAX_LIVE_MICS; solo entonces resume el producer. */
  async goLive(byRole: Role, participantId: string): Promise<void> {
    this.requireOperator(byRole);
    const p = this.require(participantId);
    if (p.state !== 'PREPARED') throw new ConcertError('not-prepared', `El participante está en ${p.state}`);
    if (!p.producerId) throw new ConcertError('no-producer', 'El participante no tiene producer');
    const live = this.countLive();
    if (live >= this.config.maxLiveMics) throw new ConcertError('max-live', `Ya hay ${live} micrófonos en vivo (máximo ${this.config.maxLiveMics})`);
    const slot = this.requireSlot(p);
    await this.media.resumeProducer(p.producerId);
    slot.state = 'LIVE';
    this.setState(p, 'LIVE');
    this.emitter.toParticipant(participantId, 'concert:live', { slotId: slot.slotId });
    this.emitter.toOperators('concert:live', { participantId, slotId: slot.slotId });
  }

  async mute(byRole: Role, participantId: string): Promise<void> {
    this.requireOperator(byRole);
    const p = this.require(participantId);
    if (p.state !== 'LIVE' || !p.producerId) throw new ConcertError('not-live', `El participante está en ${p.state}`);
    await this.media.pauseProducer(p.producerId);
    this.requireSlot(p).state = 'MUTED';
    this.setState(p, 'MUTED');
  }

  async unmute(byRole: Role, participantId: string): Promise<void> {
    this.requireOperator(byRole);
    const p = this.require(participantId);
    if (p.state !== 'MUTED' || !p.producerId) throw new ConcertError('not-muted', `El participante está en ${p.state}`);
    if (this.countLive() >= this.config.maxLiveMics) throw new ConcertError('max-live', 'No hay hueco para otro micrófono en vivo');
    await this.media.resumeProducer(p.producerId);
    this.requireSlot(p).state = 'LIVE';
    this.setState(p, 'LIVE');
  }

  /** END o CANCEL: limpieza completa y vuelta a READY. */
  async end(byRole: Role, participantId: string): Promise<void> {
    this.requireOperator(byRole);
    const p = this.require(participantId);
    if (!SLOT_STATES.includes(p.state)) throw new ConcertError('not-in-slot', `El participante está en ${p.state}`);
    await this.releaseSlot(p);
    p.timestampReady = this.now();
    this.setState(p, 'READY');
  }

  /** El participante siempre puede apagar su propio micrófono: equivale a END sobre sí mismo. */
  async stopMyMic(participantId: string): Promise<void> {
    const p = this.require(participantId);
    if (!SLOT_STATES.includes(p.state)) return;
    await this.releaseSlot(p);
    p.timestampReady = this.now();
    this.setState(p, 'READY');
  }

  /* ---------------- Selective consume ---------------- */

  /** Autorización real de consumo: solo dj/admin/audio-engine pueden consumir producers crowd-mic. */
  canConsume(role: Role, producerAppData: unknown): boolean {
    if (!isCrowdMicAppData(producerAppData)) return true; // no es un micrófono del público: reglas normales de B-Talk
    return CONSUMER_ROLES.includes(role);
  }

  /** Producers crowd-mic que un rol puede consumir ahora mismo (para el DJ al conectarse). */
  consumableProducers(role: Role): { producerId: string; participantId: string; slotId: string }[] {
    if (!CONSUMER_ROLES.includes(role)) return [];
    return [...this.participants.values()]
      .filter((p) => p.producerId && p.slotId && SLOT_STATES.includes(p.state))
      .map((p) => ({ producerId: p.producerId as string, participantId: p.participantId, slotId: p.slotId as string }));
  }

  /* ---------------- Consultas ---------------- */

  metrics(): ConcertMetrics {
    const count = (state: ParticipantState) => [...this.participants.values()].filter((p) => p.state === state).length;
    const metrics: ConcertMetrics = {
      connected: [...this.participants.values()].filter((p) => p.state !== 'DISCONNECTED').length,
      ready: count('READY'),
      preparing: count('PREPARING'),
      prepared: count('PREPARED'),
      live: count('LIVE'),
      muted: count('MUTED'),
      slots: [...this.slots.values()].map((s) => this.publicSlot(s)),
      nowPlaying: this.nowPlaying ?? null,
    };
    return metrics;
  }

  private publicSlot(s: Slot): SlotInfo {
    const info: SlotInfo = { slotId: s.slotId, state: s.state };
    if (s.participantId) info.participantId = s.participantId;
    if (s.producerId) info.producerId = s.producerId;
    if (s.since !== undefined) info.since = s.since;
    return info;
  }

  /** Listado paginado con filtro por estado y búsqueda por nombre/sector/asiento (server-side). */
  list(request: ListRequest = {}): ListResponse {
    const q = (request.query ?? '').trim().toLowerCase();
    const limit = Math.min(200, Math.max(1, request.limit ?? 50));
    const offset = Math.max(0, request.offset ?? 0);
    const items = [...this.participants.values()]
      .filter((p) => !request.state || p.state === request.state)
      .filter((p) => !q || [p.name, p.sector, p.mesa, p.asiento].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => (a.timestampReady ?? Infinity) - (b.timestampReady ?? Infinity) || a.name.localeCompare(b.name));
    return { total: items.length, offset, items: items.slice(offset, offset + limit).map((p) => this.publicInfo(p)) };
  }

  /** Cambiar de canción no afecta a los participantes: solo actualiza la metadata. */
  setNowPlaying(nowPlaying: ConcertMetrics['nowPlaying']): void {
    this.nowPlaying = nowPlaying;
    this.emitter.toOperators('concert:metrics', this.metrics());
  }

  /* ---------------- Internos ---------------- */

  private require(participantId: string): Participant {
    const p = this.participants.get(participantId);
    if (!p) throw new ConcertError('unknown-participant', 'Participante desconocido');
    return p;
  }

  private requireSlot(p: Participant): Slot {
    const slot = p.slotId ? this.slots.get(p.slotId) : undefined;
    if (!slot) throw new ConcertError('no-slot', 'El participante no tiene slot');
    return slot;
  }

  private requireOperator(role: Role): void {
    if (!OPERATOR_ROLES.includes(role)) throw new ConcertError('forbidden', 'Solo el DJ o un administrador pueden hacer esto');
  }

  private countLive(): number {
    return [...this.slots.values()].filter((s) => s.state === 'LIVE').length;
  }

  private setState(p: Participant, to: ParticipantState): void {
    if (!canTransition(p.state, to)) throw new ConcertError('invalid-transition', `${p.state} → ${to} no está permitido`);
    p.state = to;
    if (!SLOT_STATES.includes(to)) p.slotId = undefined;
    if (p.socketId) this.emitter.toParticipant(p.participantId, 'concert:state', this.publicInfo(p));
    this.emitter.toOperators('concert:participant-updated', this.publicInfo(p));
  }

  /** Cierra el producer y libera el slot (sin cambiar el estado del participante). */
  private async releaseSlot(p: Participant): Promise<void> {
    const producerId = p.producerId;
    p.producerId = undefined;
    if (producerId) {
      try {
        await this.media.closeProducer(producerId);
      } catch {
        /* el producer ya podía estar cerrado */
      }
    }
    if (p.slotId) {
      const slot = this.slots.get(p.slotId);
      if (slot && slot.participantId === p.participantId) {
        slot.state = 'EMPTY';
        slot.participantId = undefined;
        slot.producerId = undefined;
        slot.since = undefined;
      }
    }
  }

  private publicInfo(p: Participant): ParticipantInfo {
    const info: ParticipantInfo = { participantId: p.participantId, roomId: p.roomId, name: p.name, state: p.state, lastSeen: p.lastSeen };
    for (const key of ['userId', 'avatar', 'eventId', 'sector', 'mesa', 'asiento', 'device', 'userAgent'] as const) {
      const value = p[key];
      if (value !== undefined) info[key] = value;
    }
    if (p.timestampReady !== undefined) info.timestampReady = p.timestampReady;
    if (p.slotId !== undefined) info.slotId = p.slotId;
    if (p.quality !== undefined) info.quality = p.quality;
    return info;
  }
}
