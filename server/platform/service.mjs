/**
 * Lógica de negocio de la plataforma Bingo Hit: animadores y permisos, eventos (modalidad y política de
 * tarjetas desacopladas), jugadores, adquisiciones (FREE / PROMO / COMPLIMENTARY / LOCAL / PURCHASE),
 * órdenes y pagos centralizados, acceso server-side y estadísticas.
 */

import { hashToken, newId, newToken } from './auth.mjs';
import { providerFromSettings } from './payments.mjs';
import { defaultPermissions } from './store.mjs';

export const EVENT_MODES = ['LOCAL', 'ONLINE', 'HYBRID'];
export const CARD_DISTRIBUTIONS = ['FREE', 'PAID'];
export const EVENT_STATUS = ['DRAFT', 'PUBLISHED', 'LIVE', 'FINISHED', 'SUSPENDED'];
export const ORDER_STATUS = ['PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED'];
export const ACQUISITION_TYPES = ['PURCHASE', 'FREE', 'COMPLIMENTARY', 'PROMO', 'LOCAL'];

export class PlatformError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const now = () => new Date().toISOString();
const isFuture = (iso) => iso && Date.parse(iso) > Date.now();
const isPast = (iso) => iso && Date.parse(iso) <= Date.now();

export class PlatformService {
  constructor(store, options = {}) {
    this.store = store;
    this.env = options.env ?? {};
    this.appUrl = options.appUrl ?? '';
    this.apiUrl = options.apiUrl ?? '';
    this.liveState = options.liveState ?? (() => ({ concurrentPlayers: 0, liveEvents: 0 }));
    this.log = options.log ?? (() => undefined);
  }

  get settings() {
    return this.store.settings;
  }

  provider() {
    return providerFromSettings(this.settings, this.env);
  }

  /* ---------------- Animadores (solo administrador) ---------------- */

  createHost({ name, email, permissions = {} }) {
    if (!name) throw new PlatformError(400, 'name', 'Nombre obligatorio');
    const token = newToken('host');
    const user = { id: newId('host'), role: 'HOST', name: String(name).slice(0, 80), email: String(email ?? '').slice(0, 120), status: 'ACTIVE', permissions: { ...defaultPermissions(), ...permissions }, tokenHash: hashToken(token), createdAt: now() };
    this.store.insert('users', user);
    this.store.audit('admin', 'host.create', { hostId: user.id });
    return { user: this.publicUser(user), token };
  }

  updateHost(id, patch) {
    const user = this.store.get('users', id);
    if (!user || user.role !== 'HOST') throw new PlatformError(404, 'host', 'Animador no encontrado');
    const next = {};
    if (patch.name) next.name = String(patch.name).slice(0, 80);
    if (patch.email !== undefined) next.email = String(patch.email).slice(0, 120);
    if (patch.status && ['ACTIVE', 'SUSPENDED'].includes(patch.status)) next.status = patch.status;
    if (patch.permissions) next.permissions = { ...user.permissions, ...patch.permissions };
    this.store.update('users', id, next);
    this.store.audit('admin', 'host.update', { hostId: id, patch: Object.keys(next) });
    return this.publicUser(user);
  }

  rotateHostToken(id) {
    const user = this.store.get('users', id);
    if (!user) throw new PlatformError(404, 'host', 'Animador no encontrado');
    const token = newToken('host');
    this.store.update('users', id, { tokenHash: hashToken(token) });
    return { token };
  }

  listHosts() {
    return this.store.list('users', (u) => u.role === 'HOST').map((u) => this.publicUser(u));
  }

  publicUser(u) {
    const { tokenHash: _t, ...rest } = u;
    return rest;
  }

  /* ---------------- Eventos ---------------- */

  /** Precio efectivo según la política de plataforma y los permisos del animador. */
  resolvePrice(host, requested) {
    const pricing = this.settings.pricing;
    const canSet = pricing.hostCanSetPrice && host.permissions.canSetCardPrice;
    if (!canSet || requested === undefined || requested === null) return pricing.fixedCardPrice;
    const price = Number(requested);
    if (!Number.isFinite(price) || price < 0) throw new PlatformError(400, 'price', 'Precio inválido');
    if (pricing.minimumCardPrice && price < pricing.minimumCardPrice) throw new PlatformError(400, 'price', `El precio mínimo es ${pricing.minimumCardPrice}`);
    if (pricing.maximumCardPrice && price > pricing.maximumCardPrice) throw new PlatformError(400, 'price', `El precio máximo es ${pricing.maximumCardPrice}`);
    return price;
  }

  assertHostCan(host, eventMode, cardDistribution) {
    const p = host.permissions;
    if (host.status !== 'ACTIVE') throw new PlatformError(403, 'suspended', 'Animador suspendido');
    if (eventMode === 'LOCAL' && !p.canCreateLocalEvents) throw new PlatformError(403, 'permission', 'Sin permiso para eventos presenciales');
    if (eventMode === 'ONLINE' && !p.canCreateOnlineEvents) throw new PlatformError(403, 'permission', 'Sin permiso para eventos online');
    if (eventMode === 'HYBRID' && !p.canCreateHybridEvents) throw new PlatformError(403, 'permission', 'Sin permiso para eventos híbridos');
    if (cardDistribution === 'FREE' && !p.canCreateFreeEvents) throw new PlatformError(403, 'permission', 'Sin permiso para tarjetas gratis');
    if (cardDistribution === 'PAID' && !p.canCreatePaidEvents) throw new PlatformError(403, 'permission', 'Sin permiso para tarjetas pagadas');
  }

  normalizeGame(game = {}) {
    const gridSize = [3, 4, 5].includes(Number(game.gridSize)) ? Number(game.gridSize) : 5;
    const tracks = Array.isArray(game.tracks) ? game.tracks.filter((t) => Array.isArray(t) && t.length === 2).map((t) => [String(t[0]).slice(0, 120), String(t[1]).slice(0, 120)]) : [];
    return {
      seed: String(game.seed || newId('g').slice(2, 8).toUpperCase()),
      gridSize,
      freeCenter: game.freeCenter !== false,
      cardCount: Math.max(1, Math.min(100000, Number(game.cardCount) || 100)),
      playlistName: String(game.playlistName ?? '').slice(0, 120),
      topic: String(game.topic ?? '').slice(0, 120),
      tracks,
    };
  }

  createEvent(host, input) {
    const eventMode = EVENT_MODES.includes(input.eventMode) ? input.eventMode : 'LOCAL';
    const cardDistribution = CARD_DISTRIBUTIONS.includes(input.cardDistribution) ? input.cardDistribution : 'FREE';
    this.assertHostCan(host, eventMode, cardDistribution);
    if (!input.name) throw new PlatformError(400, 'name', 'Nombre del evento obligatorio');
    const capacityCap = Math.min(host.permissions.maxEventCapacity || Infinity, this.settings.limits.maxEventCapacity || Infinity);
    const capacity = Math.max(1, Math.min(Number(input.capacity) || 200, capacityCap));
    const maxPerPlayerCap = this.settings.limits.maxCardsPerPlayer || 10;
    const id = newId('event');
    const event = {
      id,
      hostId: host.id,
      name: String(input.name).slice(0, 120),
      description: String(input.description ?? '').slice(0, 2000),
      startsAt: input.startsAt || null,
      coverUrl: String(input.coverUrl ?? '').slice(0, 500),
      prizes: String(input.prizes ?? '').slice(0, 1000),
      rules: String(input.rules ?? '').slice(0, 2000),
      eventMode,
      cardDistribution,
      // HYBRID: políticas separables para presenciales y remotos (por defecto la general).
      localCardDistribution: eventMode === 'HYBRID' && CARD_DISTRIBUTIONS.includes(input.localCardDistribution) ? input.localCardDistribution : cardDistribution,
      remoteCardDistribution: eventMode === 'HYBRID' && CARD_DISTRIBUTIONS.includes(input.remoteCardDistribution) ? input.remoteCardDistribution : cardDistribution,
      capacity,
      free: {
        maxCardsPerPlayer: Math.max(1, Math.min(maxPerPlayerCap, Number(input.free?.maxCardsPerPlayer) || 1)),
        totalCardLimit: Math.max(0, Number(input.free?.totalCardLimit) || 0),
        opensAt: input.free?.opensAt || null,
        closesAt: input.free?.closesAt || null,
        allowGuests: input.free?.allowGuests !== false,
        allowPromoCodes: input.free?.allowPromoCodes !== false,
      },
      paid: {
        pricePerCard: cardDistribution === 'PAID' ? this.resolvePrice(host, input.paid?.pricePerCard) : 0,
        currency: this.settings.pricing.defaultCurrency,
        maxCardsPerPlayer: Math.max(1, Math.min(maxPerPlayerCap, Number(input.paid?.maxCardsPerPlayer) || 3)),
        totalCardLimit: Math.max(0, Number(input.paid?.totalCardLimit) || 0),
        salesStartAt: input.paid?.salesStartAt || null,
        salesEndAt: input.paid?.salesEndAt || null,
      },
      game: this.normalizeGame({ ...input.game, cardCount: input.game?.cardCount ?? capacity }),
      status: 'DRAFT',
      liveRoomId: `bingo-${id}`,
      createdAt: now(),
    };
    this.store.insert('events', event);
    this.store.audit(host.id, 'event.create', { eventId: id, eventMode, cardDistribution });
    return event;
  }

  updateEvent(host, id, patch) {
    const event = this.ownedEvent(host, id);
    if (['FINISHED', 'SUSPENDED'].includes(event.status)) throw new PlatformError(409, 'status', 'El evento no se puede editar en este estado');
    const eventMode = patch.eventMode && EVENT_MODES.includes(patch.eventMode) ? patch.eventMode : event.eventMode;
    const cardDistribution = patch.cardDistribution && CARD_DISTRIBUTIONS.includes(patch.cardDistribution) ? patch.cardDistribution : event.cardDistribution;
    if (host.role === 'HOST') this.assertHostCan(host, eventMode, cardDistribution);
    const next = { eventMode, cardDistribution };
    for (const k of ['name', 'description', 'coverUrl', 'prizes', 'rules']) if (patch[k] !== undefined) next[k] = String(patch[k]).slice(0, 2000);
    if (patch.startsAt !== undefined) next.startsAt = patch.startsAt || null;
    if (patch.capacity !== undefined) next.capacity = Math.max(1, Math.min(Number(patch.capacity) || event.capacity, Math.min(host.permissions?.maxEventCapacity || Infinity, this.settings.limits.maxEventCapacity || Infinity)));
    if (patch.free) next.free = { ...event.free, ...patch.free, maxCardsPerPlayer: Math.max(1, Math.min(this.settings.limits.maxCardsPerPlayer, Number(patch.free.maxCardsPerPlayer) || event.free.maxCardsPerPlayer)) };
    if (patch.paid) next.paid = { ...event.paid, ...patch.paid, currency: event.paid.currency, pricePerCard: host.role === 'HOST' ? this.resolvePrice(host, patch.paid.pricePerCard ?? event.paid.pricePerCard) : Number(patch.paid.pricePerCard ?? event.paid.pricePerCard) };
    if (cardDistribution === 'PAID' && event.cardDistribution !== 'PAID' && host.role === 'HOST') next.paid = { ...event.paid, ...(next.paid ?? {}), pricePerCard: this.resolvePrice(host, patch.paid?.pricePerCard) };
    if (patch.game) next.game = this.normalizeGame({ ...event.game, ...patch.game });
    if (eventMode === 'HYBRID') {
      next.localCardDistribution = CARD_DISTRIBUTIONS.includes(patch.localCardDistribution) ? patch.localCardDistribution : event.localCardDistribution ?? cardDistribution;
      next.remoteCardDistribution = CARD_DISTRIBUTIONS.includes(patch.remoteCardDistribution) ? patch.remoteCardDistribution : event.remoteCardDistribution ?? cardDistribution;
    } else {
      next.localCardDistribution = cardDistribution;
      next.remoteCardDistribution = cardDistribution;
    }
    this.store.update('events', id, next);
    return event;
  }

  setEventStatus(actor, id, status) {
    if (!EVENT_STATUS.includes(status)) throw new PlatformError(400, 'status', 'Estado inválido');
    const event = actor.role === 'PLATFORM_ADMIN' ? this.store.get('events', id) : this.ownedEvent(actor, id);
    if (!event) throw new PlatformError(404, 'event', 'Evento no encontrado');
    if (actor.role !== 'PLATFORM_ADMIN' && status === 'SUSPENDED') throw new PlatformError(403, 'permission', 'Solo el administrador suspende eventos');
    if (actor.role !== 'PLATFORM_ADMIN' && event.status === 'SUSPENDED') throw new PlatformError(403, 'suspended', 'Evento suspendido por la plataforma');
    if (status === 'LIVE' && actor.role === 'HOST' && event.eventMode !== 'LOCAL' && !actor.permissions.canStartLive) throw new PlatformError(403, 'permission', 'Sin permiso para transmitir en directo');
    this.store.update('events', id, { status, ...(status === 'LIVE' ? { liveStartedAt: now() } : {}), ...(status === 'FINISHED' ? { finishedAt: now() } : {}) });
    this.store.audit(actor.id, 'event.status', { eventId: id, status });
    return event;
  }

  ownedEvent(host, id) {
    const event = this.store.get('events', id);
    if (!event) throw new PlatformError(404, 'event', 'Evento no encontrado');
    if (host.role !== 'PLATFORM_ADMIN' && event.hostId !== host.id) throw new PlatformError(403, 'owner', 'Este evento no es tuyo');
    return event;
  }

  /** ¿Puede este usuario operar (publicar estado, transmitir) la sala Live del evento? */
  canOperateRoom(user, roomId) {
    if (!user) return false;
    if (user.role === 'PLATFORM_ADMIN') return true;
    const event = this.store.find('events', (e) => e.liveRoomId === roomId);
    if (!event) return false;
    return event.hostId === user.id && user.status === 'ACTIVE';
  }

  eventByRoom(roomId) {
    return this.store.find('events', (e) => e.liveRoomId === roomId);
  }

  publicEvent(event) {
    const cardsIssued = this.store.list('cards', (c) => c.eventId === event.id).length;
    const limit = event.cardDistribution === 'PAID' ? event.paid.totalCardLimit : event.free.totalCardLimit;
    const available = Math.max(0, Math.min(event.capacity, limit || event.capacity) - cardsIssued);
    const host = this.store.get('users', event.hostId);
    return {
      id: event.id,
      name: event.name,
      description: event.description,
      coverUrl: event.coverUrl,
      startsAt: event.startsAt,
      prizes: event.prizes,
      rules: event.rules,
      eventMode: event.eventMode,
      cardDistribution: event.cardDistribution,
      localCardDistribution: event.localCardDistribution,
      remoteCardDistribution: event.remoteCardDistribution,
      status: event.status,
      hostName: host?.name ?? '',
      songCount: event.game.tracks.length,
      liveStreamingEnabled: event.eventMode !== 'LOCAL',
      checkoutRequired: event.cardDistribution === 'PAID',
      price: event.cardDistribution === 'PAID' ? { pricePerCard: event.paid.pricePerCard, currency: event.paid.currency, maxCardsPerPlayer: event.paid.maxCardsPerPlayer, salesStartAt: event.paid.salesStartAt, salesEndAt: event.paid.salesEndAt } : null,
      free: event.cardDistribution === 'FREE' ? { maxCardsPerPlayer: event.free.maxCardsPerPlayer, opensAt: event.free.opensAt, closesAt: event.free.closesAt } : null,
      availableCards: available,
      cardsIssued,
      liveRoomId: event.liveRoomId,
    };
  }

  /* ---------------- Jugadores ---------------- */

  identifyPlayer({ name, contact }) {
    if (!name || !String(name).trim()) throw new PlatformError(400, 'name', 'Nombre obligatorio');
    const token = newToken('player');
    const player = { id: newId('player'), name: String(name).trim().slice(0, 40), contact: String(contact ?? '').slice(0, 120), status: 'ACTIVE', tokenHash: hashToken(token), createdAt: now() };
    this.store.insert('players', player);
    return { player: { id: player.id, name: player.name, contact: player.contact }, token };
  }

  playerCards(playerId, eventId) {
    return this.store.list('cards', (c) => c.playerId === playerId && (!eventId || c.eventId === eventId));
  }

  /* ---------------- Adquisición de tarjetas ---------------- */

  nextCardIndex(event) {
    const used = new Set(this.store.list('cards', (c) => c.eventId === event.id).map((c) => c.index));
    for (let i = 0; i < event.game.cardCount; i++) if (!used.has(i)) return i;
    return null;
  }

  issueCards(event, playerId, quantity, acquisitionType, extra = {}) {
    const cards = [];
    for (let i = 0; i < quantity; i++) {
      const index = this.nextCardIndex(event);
      if (index === null) break;
      cards.push(this.store.insert('cards', { id: newId('C'), eventId: event.id, playerId, index, acquisitionType, orderId: extra.orderId ?? null, promoCode: extra.promoCode ?? null, createdAt: now() }));
    }
    if (cards.length && !this.store.find('eventAccess', (a) => a.eventId === event.id && a.playerId === playerId)) {
      this.store.insert('eventAccess', { id: newId('access'), eventId: event.id, playerId, via: acquisitionType, grantedAt: now() });
    }
    return cards;
  }

  assertEventOpen(event) {
    if (!['PUBLISHED', 'LIVE'].includes(event.status)) throw new PlatformError(409, 'event-status', event.status === 'SUSPENDED' ? 'Evento suspendido' : event.status === 'FINISHED' ? 'El evento ha terminado' : 'El evento todavía no está publicado');
    const host = this.store.get('users', event.hostId);
    if (host && host.status !== 'ACTIVE') throw new PlatformError(409, 'host-suspended', 'Evento no disponible');
  }

  usePromo(event, code, player) {
    if (!code) return null;
    const promo = this.store.find('promotions', (p) => p.code.toLowerCase() === String(code).toLowerCase() && p.active && (!p.eventId || p.eventId === event.id));
    if (!promo) throw new PlatformError(400, 'promo', 'Código no válido');
    if (promo.maxUses && promo.uses >= promo.maxUses) throw new PlatformError(400, 'promo', 'Código agotado');
    if (this.store.find('cards', (c) => c.playerId === player.id && c.eventId === event.id && c.promoCode === promo.code)) throw new PlatformError(400, 'promo', 'Ya usaste este código');
    return promo;
  }

  /** FREE (o PROMO de tarjetas gratis en un evento PAID): sin checkout, sin Payment. */
  acquireFreeCards(player, eventId, { quantity = 1, promoCode } = {}) {
    const event = this.store.get('events', eventId);
    if (!event) throw new PlatformError(404, 'event', 'Evento no encontrado');
    this.assertEventOpen(event);
    const promo = event.free.allowPromoCodes || event.cardDistribution === 'PAID' ? this.usePromo(event, promoCode, player) : null;
    const viaPromo = promo && promo.type === 'FREE_CARDS';
    if (event.cardDistribution !== 'FREE' && !viaPromo) throw new PlatformError(402, 'paid', 'Este evento requiere comprar la tarjeta');
    if (event.cardDistribution === 'FREE') {
      if (isFuture(event.free.opensAt)) throw new PlatformError(409, 'not-open', 'La entrega de tarjetas todavía no ha abierto');
      if (isPast(event.free.closesAt)) throw new PlatformError(409, 'closed', 'La entrega de tarjetas ha cerrado');
    }
    const qty = viaPromo ? Math.max(1, Math.min(Number(quantity) || 1, promo.value || 1)) : Math.max(1, Number(quantity) || 1);
    const mine = this.playerCards(player.id, event.id).length;
    const maxPerPlayer = viaPromo ? Math.max(event.free.maxCardsPerPlayer, promo.value || 1) : event.free.maxCardsPerPlayer;
    if (mine + qty > maxPerPlayer) throw new PlatformError(409, 'max-per-player', `Máximo ${maxPerPlayer} tarjeta(s) por jugador`);
    const issued = this.store.list('cards', (c) => c.eventId === event.id).length;
    const limit = Math.min(event.capacity, event.free.totalCardLimit || event.capacity);
    if (issued + qty > limit) throw new PlatformError(409, 'sold-out', 'No quedan tarjetas disponibles');
    const cards = this.issueCards(event, player.id, qty, viaPromo ? 'PROMO' : 'FREE', { promoCode: promo?.code });
    if (promo) this.store.update('promotions', promo.id, { uses: promo.uses + 1 });
    return cards;
  }

  /** Cortesía / prueba / administrativa: la plataforma entrega tarjetas sin pago. */
  grantCards(actor, eventId, playerId, quantity, acquisitionType = 'COMPLIMENTARY') {
    const event = this.store.get('events', eventId);
    if (!event) throw new PlatformError(404, 'event', 'Evento no encontrado');
    if (!this.store.get('players', playerId)) throw new PlatformError(404, 'player', 'Jugador no encontrado');
    if (!['COMPLIMENTARY', 'PROMO', 'LOCAL'].includes(acquisitionType)) throw new PlatformError(400, 'type', 'Tipo inválido');
    const cards = this.issueCards(event, playerId, Math.max(1, Math.min(50, Number(quantity) || 1)), acquisitionType);
    this.store.audit(actor.id, 'cards.grant', { eventId, playerId, quantity: cards.length, acquisitionType });
    return cards;
  }

  /* ---------------- Órdenes y pagos ---------------- */

  async createOrder(player, eventId, { quantity = 1, promoCode } = {}) {
    const event = this.store.get('events', eventId);
    if (!event) throw new PlatformError(404, 'event', 'Evento no encontrado');
    this.assertEventOpen(event);
    if (event.cardDistribution !== 'PAID') throw new PlatformError(409, 'free', 'Este evento no vende tarjetas: obtén la tuya gratis');
    if (isFuture(event.paid.salesStartAt)) throw new PlatformError(409, 'not-open', 'La venta todavía no ha empezado');
    if (isPast(event.paid.salesEndAt)) throw new PlatformError(409, 'closed', 'La venta ha cerrado');
    const qty = Math.max(1, Math.min(Number(quantity) || 1, event.paid.maxCardsPerPlayer));
    const mine = this.playerCards(player.id, event.id).length;
    if (mine + qty > event.paid.maxCardsPerPlayer) throw new PlatformError(409, 'max-per-player', `Máximo ${event.paid.maxCardsPerPlayer} tarjeta(s) por jugador`);
    const issued = this.store.list('cards', (c) => c.eventId === event.id).length;
    const pending = this.store.list('orders', (o) => o.eventId === event.id && o.status === 'PENDING').reduce((n, o) => n + o.quantity, 0);
    const limit = Math.min(event.capacity, event.paid.totalCardLimit || event.capacity);
    if (issued + pending + qty > limit) throw new PlatformError(409, 'sold-out', 'No quedan tarjetas disponibles');
    const promo = this.usePromo(event, promoCode, player);
    const unitPrice = event.paid.pricePerCard;
    const subtotal = unitPrice * qty;
    const discount = promo?.type === 'DISCOUNT_PCT' ? Math.round((subtotal * Math.min(100, promo.value)) / 100) : 0;
    const total = Math.max(0, subtotal - discount);
    const order = this.store.insert('orders', { id: newId('order'), eventId: event.id, playerId: player.id, quantity: qty, unitPrice, subtotal, discount, total, currency: event.paid.currency, status: 'PENDING', promoCode: promo?.code ?? null, createdAt: now() });
    if (total === 0) {
      // Descuento del 100 %: no hay pago que procesar.
      this.confirmOrder(order.id, 'PAID', `free_${order.id}`, { provider: 'none' });
      return { order: this.store.get('orders', order.id), payment: null, redirectUrl: null };
    }
    const provider = this.provider();
    const payment = this.store.insert('payments', { id: newId('pay'), orderId: order.id, provider: provider.name, providerTransactionId: null, amount: total, currency: order.currency, status: 'PENDING', createdAt: now(), confirmedAt: null, webhookIds: [] });
    try {
      const created = await provider.createPayment(order, { appUrl: this.appUrl, apiUrl: this.apiUrl, paymentId: payment.id });
      this.store.update('payments', payment.id, { providerTransactionId: created.providerTransactionId ?? null });
      return { order, payment: this.store.get('payments', payment.id), redirectUrl: created.redirectUrl ?? null, clientData: created.clientData ?? null };
    } catch (err) {
      this.store.update('payments', payment.id, { status: 'FAILED', error: err.message });
      this.store.update('orders', order.id, { status: 'FAILED' });
      throw new PlatformError(502, 'provider', `No se pudo iniciar el pago: ${err.message}`);
    }
  }

  /** Confirmación idempotente: un webhook repetido nunca genera tarjetas duplicadas. */
  confirmOrder(orderId, status, providerEventId, extra = {}) {
    if (providerEventId && this.store.find('webhookLog', (w) => w.id === providerEventId)) return { duplicate: true, order: this.store.get('orders', orderId) };
    const order = this.store.get('orders', orderId);
    if (!order) throw new PlatformError(404, 'order', 'Orden no encontrada');
    if (providerEventId) this.store.insert('webhookLog', { id: providerEventId, orderId, status, t: now() });
    const payment = this.store.find('payments', (p) => p.orderId === orderId);
    if (order.status === 'PAID' || order.status === 'REFUNDED') return { duplicate: true, order };
    if (status === 'PAID') {
      if (payment) this.store.update('payments', payment.id, { status: 'PAID', confirmedAt: now(), providerTransactionId: extra.providerTransactionId ?? payment.providerTransactionId, webhookIds: [...payment.webhookIds, providerEventId].filter(Boolean) });
      this.store.update('orders', orderId, { status: 'PAID', paidAt: now() });
      const event = this.store.get('events', order.eventId);
      const cards = this.issueCards(event, order.playerId, order.quantity, 'PURCHASE', { orderId });
      if (order.promoCode) {
        const promo = this.store.find('promotions', (p) => p.code === order.promoCode);
        if (promo) this.store.update('promotions', promo.id, { uses: promo.uses + 1 });
      }
      this.log(`orden ${orderId} pagada: ${cards.length} tarjetas`);
      return { duplicate: false, order: this.store.get('orders', orderId), cards };
    }
    if (status === 'FAILED' || status === 'CANCELLED') {
      if (payment && payment.status === 'PENDING') this.store.update('payments', payment.id, { status: 'FAILED' });
      if (order.status === 'PENDING') this.store.update('orders', orderId, { status });
    }
    return { duplicate: false, order: this.store.get('orders', orderId) };
  }

  async handleWebhook(providerName, req) {
    const provider = this.provider();
    if (provider.name !== providerName) throw new PlatformError(404, 'provider', 'Proveedor no activo');
    let events;
    try {
      ({ events } = await provider.handleWebhook(req));
    } catch (err) {
      throw new PlatformError(400, 'webhook', err.message);
    }
    const results = [];
    for (const ev of events) {
      let order = null;
      if (ev.orderRef) order = this.store.get('orders', ev.orderRef);
      if (!order && ev.providerTransactionId) {
        const payment = this.store.find('payments', (p) => p.providerTransactionId === ev.providerTransactionId);
        if (payment) order = this.store.get('orders', payment.orderId);
      }
      if (!order) {
        results.push({ eventId: ev.eventId, ignored: true });
        continue;
      }
      results.push({ eventId: ev.eventId, ...this.confirmOrder(order.id, ev.status, ev.eventId, { providerTransactionId: ev.providerTransactionId }) });
    }
    return results;
  }

  /** Solo con el proveedor mock (desarrollo/pruebas): genera el webhook firmado como lo haría el gateway. */
  async simulateMockPayment(paymentId, result) {
    const provider = this.provider();
    if (provider.name !== 'mock') throw new PlatformError(404, 'provider', 'Solo disponible con el proveedor de pruebas');
    const payment = this.store.get('payments', paymentId);
    if (!payment) throw new PlatformError(404, 'payment', 'Pago no encontrado');
    const payload = { eventId: `mock_evt_${paymentId}_${result}`, providerTransactionId: payment.providerTransactionId, status: result === 'approved' ? 'PAID' : 'FAILED' };
    return this.handleWebhook('mock', { headers: { 'x-mock-signature': provider.sign(payload) }, body: payload, query: {} });
  }

  async refundOrder(actor, orderId) {
    const order = this.store.get('orders', orderId);
    if (!order) throw new PlatformError(404, 'order', 'Orden no encontrada');
    if (order.status !== 'PAID') throw new PlatformError(409, 'status', 'Solo se reembolsan órdenes pagadas');
    const payment = this.store.find('payments', (p) => p.orderId === orderId);
    let result = { status: 'REFUNDED' };
    if (payment && payment.provider !== 'none') result = await this.provider().refundPayment(payment, order.total);
    if (result.status !== 'REFUNDED') throw new PlatformError(502, 'refund', 'El proveedor no aceptó el reembolso');
    if (payment) this.store.update('payments', payment.id, { status: 'REFUNDED', refundedAt: now(), providerRefundId: result.providerRefundId ?? null });
    this.store.update('orders', orderId, { status: 'REFUNDED', refundedAt: now() });
    for (const card of this.store.list('cards', (c) => c.orderId === orderId)) this.store.update('cards', card.id, { revoked: true });
    this.store.audit(actor.id, 'order.refund', { orderId });
    return this.store.get('orders', orderId);
  }

  createPromotion(actor, input) {
    const code = String(input.code ?? '').trim().toUpperCase();
    if (!code) throw new PlatformError(400, 'code', 'Código obligatorio');
    if (this.store.find('promotions', (p) => p.code === code)) throw new PlatformError(409, 'code', 'Código ya existe');
    const type = input.type === 'DISCOUNT_PCT' ? 'DISCOUNT_PCT' : 'FREE_CARDS';
    const promo = this.store.insert('promotions', { id: newId('promo'), code, eventId: input.eventId || null, type, value: Math.max(1, Number(input.value) || 1), maxUses: Math.max(0, Number(input.maxUses) || 0), uses: 0, active: input.active !== false, createdAt: now() });
    this.store.audit(actor.id, 'promo.create', { code });
    return promo;
  }

  /* ---------------- Acceso centralizado ---------------- */

  /** Regla única de acceso a la partida: la usan la API y el socket Live. */
  canPlayerJoinEvent(playerId, eventId) {
    const event = this.store.get('events', eventId);
    if (!event) return { allowed: false, reason: 'event-not-found' };
    const player = this.store.get('players', playerId);
    if (!player) return { allowed: false, reason: 'unknown-player' };
    if (player.status !== 'ACTIVE') return { allowed: false, reason: 'blocked' };
    const host = this.store.get('users', event.hostId);
    if (host && host.status !== 'ACTIVE') return { allowed: false, reason: 'host-suspended' };
    if (event.status === 'SUSPENDED') return { allowed: false, reason: 'event-suspended' };
    if (event.status === 'DRAFT') return { allowed: false, reason: 'event-not-published' };
    const cards = this.playerCards(playerId, eventId).filter((c) => !c.revoked);
    if (cards.length === 0) return { allowed: false, reason: event.cardDistribution === 'PAID' ? 'purchase-required' : 'card-required', event };
    const waiting = event.status === 'PUBLISHED' && isFuture(event.startsAt);
    return { allowed: true, waiting, startsAt: event.startsAt, cards, event, finished: event.status === 'FINISHED' };
  }

  accessBundle(playerId, eventId) {
    const access = this.canPlayerJoinEvent(playerId, eventId);
    if (!access.allowed) return access;
    const e = access.event;
    return {
      allowed: true,
      waiting: access.waiting,
      finished: access.finished,
      startsAt: e.startsAt,
      event: this.publicEvent(e),
      cards: access.cards.map((c) => ({ id: c.id, index: c.index, acquisitionType: c.acquisitionType })),
      game: { seed: e.game.seed, gridSize: e.game.gridSize, freeCenter: e.game.freeCenter, cardCount: e.game.cardCount, poolSize: e.game.tracks.length, pool: e.game.tracks, topic: e.game.topic, title: e.game.playlistName || e.name },
      live: { roomId: e.liveRoomId, streaming: e.eventMode !== 'LOCAL' },
    };
  }

  /* ---------------- Estadísticas ---------------- */

  eventStats(eventId) {
    const cards = this.store.list('cards', (c) => c.eventId === eventId && !c.revoked);
    const orders = this.store.list('orders', (o) => o.eventId === eventId);
    const paid = orders.filter((o) => o.status === 'PAID');
    const grossSales = paid.reduce((n, o) => n + o.total, 0);
    const refunds = orders.filter((o) => o.status === 'REFUNDED').reduce((n, o) => n + o.total, 0);
    const players = new Set(cards.map((c) => c.playerId));
    const fee = this.settings.commission.platformFeePct || 0;
    const platformRevenue = Math.round((grossSales * fee) / 100);
    return {
      eventId,
      cardsFree: cards.filter((c) => c.acquisitionType === 'FREE').length,
      cardsPaid: cards.filter((c) => c.acquisitionType === 'PURCHASE').length,
      cardsPromo: cards.filter((c) => c.acquisitionType === 'PROMO').length,
      cardsComplimentary: cards.filter((c) => c.acquisitionType === 'COMPLIMENTARY' || c.acquisitionType === 'LOCAL').length,
      cardsTotal: cards.length,
      ordersPaid: paid.length,
      ordersPending: orders.filter((o) => o.status === 'PENDING').length,
      ordersFailed: orders.filter((o) => o.status === 'FAILED' || o.status === 'CANCELLED').length,
      ordersRefunded: orders.filter((o) => o.status === 'REFUNDED').length,
      grossSales,
      refunds,
      // Conceptual: la plataforma cobró; una liquidación al animador sería un proceso aparte.
      platformRevenue,
      hostSettlement: grossSales - refunds - platformRevenue,
      uniquePlayers: players.size,
      avgCardsPerPlayer: players.size ? Math.round((cards.length / players.size) * 100) / 100 : 0,
    };
  }

  globalStats() {
    const events = this.store.list('events');
    const perEvent = events.map((e) => ({ id: e.id, name: e.name, hostId: e.hostId, eventMode: e.eventMode, cardDistribution: e.cardDistribution, status: e.status, ...this.eventStats(e.id) }));
    const hosts = this.listHosts().map((h) => {
      const mine = perEvent.filter((e) => e.hostId === h.id);
      return { id: h.id, name: h.name, status: h.status, events: mine.length, grossSales: mine.reduce((n, e) => n + e.grossSales, 0), cardsTotal: mine.reduce((n, e) => n + e.cardsTotal, 0) };
    });
    const live = this.liveState();
    const sum = (k) => perEvent.reduce((n, e) => n + e[k], 0);
    return {
      totalEvents: events.length,
      activeEvents: events.filter((e) => ['PUBLISHED', 'LIVE'].includes(e.status)).length,
      liveEvents: live.liveEvents,
      hosts: hosts.length,
      players: this.store.list('players').length,
      concurrentPlayers: live.concurrentPlayers,
      cardsFree: sum('cardsFree'),
      cardsPaid: sum('cardsPaid'),
      grossSales: sum('grossSales'),
      platformRevenue: sum('platformRevenue'),
      ordersPending: sum('ordersPending'),
      ordersFailed: sum('ordersFailed'),
      refunds: sum('refunds'),
      perEvent,
      perHost: hosts,
    };
  }
}
