/** Cliente de la API de la plataforma Bingo Hit. Los tokens viven en el navegador; nunca hay secretos del servidor aquí. */

import { detectConcertServer } from '../concert/session.js';

export type EventMode = 'LOCAL' | 'ONLINE' | 'HYBRID';
export type CardDistribution = 'FREE' | 'PAID';
export type EventStatus = 'DRAFT' | 'PUBLISHED' | 'LIVE' | 'FINISHED' | 'SUSPENDED';

export interface PublicEvent {
  id: string;
  name: string;
  description: string;
  coverUrl: string;
  startsAt: string | null;
  prizes: string;
  rules: string;
  eventMode: EventMode;
  cardDistribution: CardDistribution;
  status: EventStatus;
  hostName: string;
  songCount: number;
  liveStreamingEnabled: boolean;
  checkoutRequired: boolean;
  price: { pricePerCard: number; currency: string; maxCardsPerPlayer: number; salesStartAt: string | null; salesEndAt: string | null } | null;
  free: { maxCardsPerPlayer: number; opensAt: string | null; closesAt: string | null } | null;
  availableCards: number;
  cardsIssued: number;
  liveRoomId: string;
}

export interface AccessBundle {
  allowed: boolean;
  reason?: string;
  waiting?: boolean;
  finished?: boolean;
  startsAt?: string | null;
  event?: PublicEvent;
  cards?: { id: string; index: number; acquisitionType: string }[];
  game?: { seed: string; gridSize: 3 | 4 | 5; freeCenter: boolean; cardCount: number; poolSize: number; pool: [string, string][]; topic: string; title: string };
  live?: { roomId: string; streaming: boolean };
}

export interface Order {
  id: string;
  eventId: string;
  playerId: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  discount: number;
  total: number;
  currency: string;
  status: 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED' | 'REFUNDED';
  createdAt: string;
}

export interface HostEvent {
  id: string;
  hostId: string;
  name: string;
  description: string;
  startsAt: string | null;
  coverUrl: string;
  prizes: string;
  rules: string;
  eventMode: EventMode;
  cardDistribution: CardDistribution;
  localCardDistribution: CardDistribution;
  remoteCardDistribution: CardDistribution;
  capacity: number;
  free: { maxCardsPerPlayer: number; totalCardLimit: number; opensAt: string | null; closesAt: string | null; allowGuests: boolean; allowPromoCodes: boolean };
  paid: { pricePerCard: number; currency: string; maxCardsPerPlayer: number; totalCardLimit: number; salesStartAt: string | null; salesEndAt: string | null };
  game: { seed: string; gridSize: 3 | 4 | 5; freeCenter: boolean; cardCount: number; playlistName: string; topic: string; tracks: [string, string][] };
  status: EventStatus;
  liveRoomId: string;
  createdAt: string;
  stats?: EventStats;
}

export interface EventStats {
  cardsFree: number;
  cardsPaid: number;
  cardsPromo: number;
  cardsComplimentary: number;
  cardsTotal: number;
  ordersPaid: number;
  ordersPending: number;
  ordersFailed: number;
  ordersRefunded: number;
  grossSales: number;
  refunds: number;
  platformRevenue: number;
  hostSettlement: number;
  uniquePlayers: number;
  avgCardsPerPlayer: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const PLAYER_TOKEN_KEY = 'bh:playerToken';
const PLAYER_NAME_KEY = 'bh:playerName';
const SERVER_KEY = 'bh:server';
const HOST_TOKEN_KEY = 'bh:hostToken';
const ADMIN_TOKEN_KEY = 'bh:adminToken';

function storage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? localStorage : sessionStorage;
  } catch {
    return null;
  }
}

export const tokens = {
  player: () => storage('local')?.getItem(PLAYER_TOKEN_KEY) ?? '',
  setPlayer: (t: string, name: string) => {
    storage('local')?.setItem(PLAYER_TOKEN_KEY, t);
    storage('local')?.setItem(PLAYER_NAME_KEY, name);
  },
  playerName: () => storage('local')?.getItem(PLAYER_NAME_KEY) ?? '',
  host: () => storage('session')?.getItem(HOST_TOKEN_KEY) ?? '',
  setHost: (t: string) => storage('session')?.setItem(HOST_TOKEN_KEY, t),
  admin: () => storage('session')?.getItem(ADMIN_TOKEN_KEY) ?? '',
  setAdmin: (t: string) => storage('session')?.setItem(ADMIN_TOKEN_KEY, t),
};

let serverUrl: string | null = null;

/** URL del servidor de la plataforma: parámetro `l`, valor guardado o el propio origen si sirve la app. */
export async function resolveServer(explicit?: string | null): Promise<string> {
  if (explicit) {
    serverUrl = explicit.replace(/\/$/, '');
    storage('local')?.setItem(SERVER_KEY, serverUrl);
    return serverUrl;
  }
  if (serverUrl) return serverUrl;
  const detected = await detectConcertServer();
  serverUrl = detected ?? storage('local')?.getItem(SERVER_KEY) ?? '';
  return serverUrl;
}

export function currentServer(): string {
  return serverUrl ?? storage('local')?.getItem(SERVER_KEY) ?? '';
}

export async function api<T>(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<T> {
  const base = currentServer();
  if (!base) throw new ApiError(0, 'no-server', 'No hay servidor Bingo Hit configurado');
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) } };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const res = await fetch(`${base}${path}`, init);
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? `HTTP ${res.status}`);
  return data as T;
}

export const playerApi = {
  identify: (name: string, contact: string) => api<{ player: { id: string; name: string }; token: string }>('POST', '/api/players', { body: { name, contact } }),
  me: () => api<{ id: string; name: string; cards: { eventId: string; index: number }[] }>('GET', '/api/me', { token: tokens.player() }),
  event: (id: string) => api<PublicEvent>('GET', `/api/events/${encodeURIComponent(id)}`),
  access: (id: string) => api<AccessBundle>('GET', `/api/events/${encodeURIComponent(id)}/access`, { token: tokens.player() }),
  freeCards: (id: string, quantity: number, promoCode?: string) => api<{ cards: { id: string; index: number }[] }>('POST', `/api/events/${encodeURIComponent(id)}/cards/free`, { token: tokens.player(), body: { quantity, promoCode } }),
  order: (id: string, quantity: number, promoCode?: string) => api<{ order: Order; paymentId: string | null; redirectUrl: string | null }>('POST', `/api/events/${encodeURIComponent(id)}/orders`, { token: tokens.player(), body: { quantity, promoCode } }),
  orderStatus: (id: string) => api<{ order: Order; cards: { id: string; index: number }[] }>('GET', `/api/orders/${encodeURIComponent(id)}`, { token: tokens.player() }),
  simulateMock: (paymentId: string, result: 'approved' | 'rejected') => api<unknown>('POST', '/api/payments/mock/simulate', { body: { paymentId, result } }),
  info: () => api<{ paymentProvider: string; mockPayments: boolean; currency: string }>('GET', '/api/platform/info'),
};

export const hostApi = {
  me: () => api<{ id: string; role: string; name: string; permissions: Record<string, boolean | number>; pricing: { hostCanSetPrice: boolean; fixedCardPrice: number; minimumCardPrice: number; maximumCardPrice: number; currency: string } }>('GET', '/api/host/me', { token: tokens.host() }),
  events: () => api<HostEvent[]>('GET', '/api/host/events', { token: tokens.host() }),
  event: (id: string) => api<HostEvent>('GET', `/api/host/events/${id}`, { token: tokens.host() }),
  create: (body: unknown) => api<HostEvent>('POST', '/api/host/events', { token: tokens.host(), body }),
  update: (id: string, body: unknown) => api<HostEvent>('PATCH', `/api/host/events/${id}`, { token: tokens.host(), body }),
  setGame: (id: string, game: unknown) => api<HostEvent>('PUT', `/api/host/events/${id}/game`, { token: tokens.host(), body: game }),
  publish: (id: string) => api<HostEvent>('POST', `/api/host/events/${id}/publish`, { token: tokens.host() }),
  start: (id: string) => api<HostEvent>('POST', `/api/host/events/${id}/start`, { token: tokens.host() }),
  finish: (id: string) => api<HostEvent>('POST', `/api/host/events/${id}/finish`, { token: tokens.host() }),
  stats: (id: string) => api<EventStats>('GET', `/api/host/events/${id}/stats`, { token: tokens.host() }),
  players: (id: string) => api<{ playerId: string; name: string; cards: { index: number; acquisitionType: string }[] }[]>('GET', `/api/host/events/${id}/players`, { token: tokens.host() }),
};

export const adminApi = {
  stats: () => api<Record<string, unknown> & { perEvent: (EventStats & { id: string; name: string; hostId: string; status: string; eventMode: string; cardDistribution: string })[]; perHost: { id: string; name: string; status: string; events: number; grossSales: number; cardsTotal: number }[] }>('GET', '/api/admin/stats', { token: tokens.admin() }),
  hosts: () => api<{ id: string; name: string; email: string; username?: string; status: string; permissions: Record<string, boolean | number> }[]>('GET', '/api/admin/hosts', { token: tokens.admin() }),
  createHost: (body: unknown) => api<{ user: { id: string; name: string }; token: string }>('POST', '/api/admin/hosts', { token: tokens.admin(), body }),
  updateHost: (id: string, body: unknown) => api<unknown>('PATCH', `/api/admin/hosts/${id}`, { token: tokens.admin(), body }),
  rotateToken: (id: string) => api<{ token: string }>('POST', `/api/admin/hosts/${id}/token`, { token: tokens.admin() }),
  events: () => api<HostEvent[]>('GET', '/api/admin/events', { token: tokens.admin() }),
  setEventStatus: (id: string, status: EventStatus) => api<unknown>('PATCH', `/api/admin/events/${id}`, { token: tokens.admin(), body: { status } }),
  settings: () => api<Record<string, any>>('GET', '/api/admin/settings', { token: tokens.admin() }),
  saveSettings: (body: unknown) => api<Record<string, any>>('PUT', '/api/admin/settings', { token: tokens.admin(), body }),
  promotions: () => api<{ code: string; type: string; value: number; maxUses: number; uses: number; active: boolean; eventId: string | null }[]>('GET', '/api/admin/promotions', { token: tokens.admin() }),
  createPromotion: (body: unknown) => api<unknown>('POST', '/api/admin/promotions', { token: tokens.admin(), body }),
  complimentary: (body: unknown) => api<{ cards: unknown[] }>('POST', '/api/admin/cards/complimentary', { token: tokens.admin(), body }),
  orders: () => api<Order[]>('GET', '/api/admin/orders', { token: tokens.admin() }),
  refund: (id: string) => api<Order>('POST', `/api/admin/orders/${id}/refund`, { token: tokens.admin() }),
  players: () => api<{ id: string; name: string; contact: string }[]>('GET', '/api/admin/players', { token: tokens.admin() }),
};

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('es-CL', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return 'Fecha por confirmar';
  const d = new Date(iso);
  return d.toLocaleString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}
