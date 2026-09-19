/** Cliente del DJ: vista en vivo de participantes/slots (deltas + paginación) y órdenes al servidor. */

import { EVENTS, type ConcertMetrics, type JoinAck, type ListRequest, type ListResponse, type ParticipantInfo, type SlotInfo } from './protocol.js';
import type { ConcertSignaling } from './signaling.js';

export interface DjEvent {
  t: number;
  kind: 'info' | 'error';
  text: string;
}

export class DjClient {
  readonly participants = new Map<string, ParticipantInfo>();
  metrics: ConcertMetrics | null = null;
  readonly log: DjEvent[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: (() => void)[] = [];
  private now: () => number;

  constructor(
    readonly signaling: ConcertSignaling,
    readonly roomId: string,
    options: { now?: () => number; logLimit?: number } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.logLimit = options.logLimit ?? 50;
  }
  private readonly logLimit: number;

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((l) => l());
  }

  private note(kind: DjEvent['kind'], text: string): void {
    this.log.unshift({ t: this.now(), kind, text });
    if (this.log.length > this.logLimit) this.log.length = this.logLimit;
  }

  get slots(): SlotInfo[] {
    return this.metrics?.slots ?? [];
  }

  participant(id: string | undefined): ParticipantInfo | undefined {
    return id ? this.participants.get(id) : undefined;
  }

  async connect(name = 'DJ'): Promise<void> {
    if (this.unsubscribe.length === 0) {
      const upsert = (info: ParticipantInfo) => {
        this.participants.set(info.participantId, info);
        this.notify();
      };
      this.unsubscribe.push(
        this.signaling.on(EVENTS.participantAdded, upsert),
        this.signaling.on(EVENTS.participantUpdated, upsert),
        this.signaling.on(EVENTS.participantRemoved, (p: { participantId: string }) => {
          this.participants.delete(p.participantId);
          this.notify();
        }),
        this.signaling.on(EVENTS.metrics, (m: ConcertMetrics) => {
          this.metrics = m;
          this.notify();
        }),
        this.signaling.on(EVENTS.preparing, (p: { participantId: string; slotId: string }) => this.note('info', `${this.nameOf(p.participantId)} preparando en ${p.slotId}`)),
        this.signaling.on(EVENTS.prepared, (p: { participantId: string; slotId: string }) => this.note('info', `${this.nameOf(p.participantId)} listo en ${p.slotId}`)),
        this.signaling.on(EVENTS.prepareFailed, (p: { participantId: string; slotId?: string; reason: string; detail?: string }) => this.note('error', `${this.nameOf(p.participantId)} falló al preparar (${p.reason})${p.detail ? `: ${p.detail}` : ''}`)),
        this.signaling.on(EVENTS.live, (p: { participantId: string; slotId: string }) => this.note('info', `${this.nameOf(p.participantId)} EN VIVO en ${p.slotId}`)),
        this.signaling.on(EVENTS.error, (e: { code: string; participantId?: string; slotId?: string; message?: string }) =>
          this.note('error', e.code === 'participant-lost' ? `${this.nameOf(e.participantId ?? '')} perdió la conexión (${e.slotId ?? ''})` : (e.message ?? e.code)),
        ),
      );
    }
    await this.signaling.connect();
    await this.signaling.request<JoinAck>(EVENTS.join, { roomId: this.roomId, meta: { name } });
    await this.refresh();
  }

  private nameOf(id: string): string {
    return this.participants.get(id)?.name ?? id.slice(0, 6);
  }

  /** Recarga completa (tras reconectar): lista completa + métricas. */
  async refresh(): Promise<void> {
    const all = await this.list({ limit: 10_000 });
    this.participants.clear();
    for (const p of all.items) this.participants.set(p.participantId, p);
    const m = await this.signaling.request<ConcertMetrics>(EVENTS.metrics);
    const { ok: _ok, ...metrics } = m;
    this.metrics = metrics as ConcertMetrics;
    this.notify();
  }

  list(request: ListRequest): Promise<ListResponse> {
    return this.signaling.request<ListResponse>(EVENTS.list, request);
  }

  /** Lista READY local (delta) ordenada por antigüedad, con búsqueda y paginación. */
  readyPage(query = '', offset = 0, limit = 50): { total: number; items: ParticipantInfo[] } {
    const q = query.trim().toLowerCase();
    const items = [...this.participants.values()]
      .filter((p) => p.state === 'READY')
      .filter((p) => !q || [p.name, p.sector, p.mesa, p.asiento].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => (a.timestampReady ?? 0) - (b.timestampReady ?? 0));
    return { total: items.length, items: items.slice(offset, offset + limit) };
  }

  private async command(event: string, participantId: string, extra: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.signaling.request(event, { participantId, ...extra });
    } catch (err) {
      this.note('error', err instanceof Error ? err.message : String(err));
      this.notify();
      throw err;
    }
  }

  prepare(participantId: string, slotId?: string): Promise<void> {
    return this.command(EVENTS.prepare, participantId, slotId ? { slotId } : {});
  }
  goLive(participantId: string): Promise<void> {
    return this.command(EVENTS.goLive, participantId);
  }
  mute(participantId: string): Promise<void> {
    return this.command(EVENTS.mute, participantId);
  }
  unmute(participantId: string): Promise<void> {
    return this.command(EVENTS.unmute, participantId);
  }
  /** END y CANCEL son la misma orden en el servidor: limpieza completa y vuelta a READY. */
  end(participantId: string): Promise<void> {
    return this.command(EVENTS.end, participantId);
  }

  disconnect(): void {
    this.signaling.disconnect();
    this.unsubscribe.splice(0).forEach((u) => u());
  }
}
