/**
 * API HTTP de la plataforma Bingo Hit, sin dependencias (funciona con Express o con http nativo).
 * Toda autorización es server-side: rol por token Bearer, permisos del animador, propiedad de eventos y tarjetas.
 */

import { hashPassword, hashToken, identify } from './auth.mjs';
import { PlatformError } from './service.mjs';

const MAX_BODY = 256 * 1024;

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new PlatformError(413, 'body', 'Cuerpo demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new PlatformError(400, 'json', 'JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

function pattern(path) {
  const keys = [];
  const re = new RegExp('^' + path.replace(/\//g, '\\/').replace(/:(\w+)/g, (_m, k) => {
    keys.push(k);
    return '([^/]+)';
  }) + '$');
  return { re, keys };
}

/** Crea el manejador HTTP. Devuelve `handle(req, res) → boolean` (false si la ruta no es de la API). */
export function createPlatformApi(service, options = {}) {
  const adminTokenHash = options.adminToken ? hashToken(options.adminToken) : null;
  const adminCredentials = options.adminPassword ? { username: String(options.adminUser || 'admin').toLowerCase(), passwordHash: hashPassword(options.adminPassword) } : null;
  const mockEnabled = options.mockPayments !== false;
  const routes = [];
  const on = (method, path, auth, handler) => routes.push({ method, ...pattern(path), auth, handler });
  const store = service.store;

  const requireRole = (who, ...roles) => {
    if (!roles.includes(who.role)) throw new PlatformError(who.role === 'ANON' ? 401 : 403, 'auth', who.role === 'SUSPENDED' ? 'Cuenta suspendida' : 'No autorizado');
  };
  const publicEvent = (id) => {
    const e = store.get('events', id);
    if (!e) throw new PlatformError(404, 'event', 'Evento no encontrado');
    return e;
  };
  const maskSettings = (s) => ({
    ...s,
    payments: { ...s.payments, providers: { transbank: { ...s.payments.providers.transbank, apiKey: s.payments.providers.transbank.apiKey ? '••••' : '' }, mercadopago: { ...s.payments.providers.mercadopago, accessToken: s.payments.providers.mercadopago.accessToken ? '••••' : '', webhookSecret: s.payments.providers.mercadopago.webhookSecret ? '••••' : '' } } },
  });

  /* ---- Sesión (usuario y contraseña) ---- */
  on('POST', '/api/auth/login', 'any', ({ body }) => service.login(body.username, body.password, adminCredentials));
  on('POST', '/api/auth/logout', 'any', ({ headers }) => {
    const auth = String(headers.authorization || '');
    if (auth.startsWith('Bearer ')) service.logout(auth.slice(7).trim());
    return {};
  });
  on('GET', '/api/auth/me', 'any', ({ who }) => {
    if (who.role === 'PLATFORM_ADMIN') return { role: 'PLATFORM_ADMIN', id: 'admin', name: 'Administrador' };
    if (who.role === 'HOST') return { role: 'HOST', id: who.user.id, name: who.user.name, username: who.user.username, permissions: who.user.permissions };
    throw new PlatformError(401, 'auth', 'Sin sesión');
  });
  on('POST', '/api/auth/password', 'any', ({ who, body }) => {
    requireRole(who, 'HOST');
    service.setPassword(who.id, body.newPassword, body.currentPassword ?? '');
    return {};
  });

  /* ---- Público ---- */
  on('GET', '/api/platform/info', 'any', () => ({ platform: 'bingo-hit', paymentProvider: service.provider().name, mockPayments: mockEnabled && service.provider().name === 'mock', currency: service.settings.pricing.defaultCurrency, eventModes: ['LOCAL', 'ONLINE', 'HYBRID'], cardDistributions: ['FREE', 'PAID'] }));
  on('GET', '/api/events', 'any', () => store.list('events', (e) => ['PUBLISHED', 'LIVE'].includes(e.status)).map((e) => service.publicEvent(e)));
  on('GET', '/api/events/:id', 'any', ({ params }) => service.publicEvent(publicEvent(params.id)));
  on('POST', '/api/players', 'any', ({ body }) => service.identifyPlayer(body));
  on('GET', '/api/me', 'any', ({ who }) => {
    requireRole(who, 'PLAYER');
    return { id: who.player.id, name: who.player.name, contact: who.player.contact, cards: service.playerCards(who.id).map((c) => ({ id: c.id, eventId: c.eventId, index: c.index, acquisitionType: c.acquisitionType, revoked: !!c.revoked })) };
  });
  on('GET', '/api/events/:id/access', 'any', ({ who, params }) => {
    requireRole(who, 'PLAYER');
    return service.accessBundle(who.id, params.id);
  });
  on('POST', '/api/events/:id/cards/free', 'any', ({ who, params, body }) => {
    requireRole(who, 'PLAYER');
    const cards = service.acquireFreeCards(who.player, params.id, body);
    return { cards: cards.map((c) => ({ id: c.id, index: c.index, acquisitionType: c.acquisitionType })) };
  });
  on('POST', '/api/events/:id/orders', 'any', async ({ who, params, body }) => {
    requireRole(who, 'PLAYER');
    const r = await service.createOrder(who.player, params.id, body);
    return { order: r.order, paymentId: r.payment?.id ?? null, redirectUrl: r.redirectUrl, clientData: r.clientData ?? null };
  });
  on('GET', '/api/orders/:id', 'any', ({ who, params }) => {
    const order = store.get('orders', params.id);
    if (!order) throw new PlatformError(404, 'order', 'Orden no encontrada');
    const event = store.get('events', order.eventId);
    const allowed = who.role === 'PLATFORM_ADMIN' || (who.role === 'PLAYER' && who.id === order.playerId) || (who.role === 'HOST' && event?.hostId === who.id);
    if (!allowed) throw new PlatformError(who.role === 'ANON' ? 401 : 403, 'auth', 'No autorizado');
    const cards = store.list('cards', (c) => c.orderId === order.id).map((c) => ({ id: c.id, index: c.index }));
    return { order, cards };
  });
  on('POST', '/api/payments/:provider/webhook', 'any', async ({ params, body, headers, query }) => ({ results: await service.handleWebhook(params.provider, { headers, body, query }) }));
  on('GET', '/api/payments/:provider/webhook', 'any', async ({ params, headers, query }) => ({ results: await service.handleWebhook(params.provider, { headers, body: {}, query }) }));
  on('POST', '/api/payments/mock/simulate', 'any', async ({ body }) => {
    if (!mockEnabled) throw new PlatformError(404, 'mock', 'No disponible');
    return { results: await service.simulateMockPayment(String(body.paymentId ?? ''), body.result === 'approved' ? 'approved' : 'rejected') };
  });

  /* ---- Animador ---- */
  const host = (who) => {
    requireRole(who, 'HOST', 'PLATFORM_ADMIN');
    return who.role === 'PLATFORM_ADMIN' ? { id: 'admin', role: 'PLATFORM_ADMIN', status: 'ACTIVE', permissions: { canCreateLocalEvents: true, canCreateOnlineEvents: true, canCreateHybridEvents: true, canCreateFreeEvents: true, canCreatePaidEvents: true, canSetCardPrice: true, canStartLive: true, maxEventCapacity: Infinity } } : who.user;
  };
  on('GET', '/api/host/me', 'any', ({ who }) => {
    const h = host(who);
    return { id: h.id, role: h.role, name: h.name ?? 'Administrador', username: h.username ?? 'admin', permissions: h.permissions, pricing: { hostCanSetPrice: service.settings.pricing.hostCanSetPrice && !!h.permissions.canSetCardPrice, fixedCardPrice: service.settings.pricing.fixedCardPrice, minimumCardPrice: service.settings.pricing.minimumCardPrice, maximumCardPrice: service.settings.pricing.maximumCardPrice, currency: service.settings.pricing.defaultCurrency } };
  });
  on('GET', '/api/host/events', 'any', ({ who }) => {
    const h = host(who);
    return store.list('events', (e) => h.role === 'PLATFORM_ADMIN' || e.hostId === h.id).map((e) => ({ ...e, stats: service.eventStats(e.id) }));
  });
  on('POST', '/api/host/events', 'any', ({ who, body }) => service.createEvent(host(who), body));
  on('GET', '/api/host/events/:id', 'any', ({ who, params }) => {
    const e = service.ownedEvent(host(who), params.id);
    return { ...e, stats: service.eventStats(e.id) };
  });
  on('PATCH', '/api/host/events/:id', 'any', ({ who, params, body }) => service.updateEvent(host(who), params.id, body));
  on('PUT', '/api/host/events/:id/game', 'any', ({ who, params, body }) => service.updateEvent(host(who), params.id, { game: body }));
  on('POST', '/api/host/events/:id/publish', 'any', ({ who, params }) => service.setEventStatus(host(who), params.id, 'PUBLISHED'));
  on('POST', '/api/host/events/:id/start', 'any', ({ who, params }) => service.setEventStatus(host(who), params.id, 'LIVE'));
  on('POST', '/api/host/events/:id/finish', 'any', ({ who, params }) => service.setEventStatus(host(who), params.id, 'FINISHED'));
  on('GET', '/api/host/events/:id/stats', 'any', ({ who, params }) => service.eventStats(service.ownedEvent(host(who), params.id).id));
  on('GET', '/api/host/events/:id/players', 'any', ({ who, params }) => {
    const e = service.ownedEvent(host(who), params.id);
    const cards = store.list('cards', (c) => c.eventId === e.id);
    const byPlayer = new Map();
    for (const c of cards) {
      const p = store.get('players', c.playerId);
      const entry = byPlayer.get(c.playerId) ?? { playerId: c.playerId, name: p?.name ?? '?', cards: [] };
      entry.cards.push({ id: c.id, index: c.index, acquisitionType: c.acquisitionType, revoked: !!c.revoked });
      byPlayer.set(c.playerId, entry);
    }
    return [...byPlayer.values()];
  });
  on('GET', '/api/host/events/:id/orders', 'any', ({ who, params }) => store.list('orders', (o) => o.eventId === service.ownedEvent(host(who), params.id).id));

  /* ---- Administrador general ---- */
  const admin = (who) => requireRole(who, 'PLATFORM_ADMIN');
  on('GET', '/api/admin/stats', 'any', ({ who }) => (admin(who), service.globalStats()));
  on('GET', '/api/admin/hosts', 'any', ({ who }) => (admin(who), service.listHosts()));
  on('POST', '/api/admin/hosts', 'any', ({ who, body }) => (admin(who), service.createHost(body)));
  on('PATCH', '/api/admin/hosts/:id', 'any', ({ who, params, body }) => (admin(who), service.updateHost(params.id, body)));
  on('POST', '/api/admin/hosts/:id/token', 'any', ({ who, params }) => (admin(who), service.rotateHostToken(params.id)));
  on('GET', '/api/admin/events', 'any', ({ who }) => (admin(who), store.list('events').map((e) => ({ ...e, stats: service.eventStats(e.id) }))));
  on('PATCH', '/api/admin/events/:id', 'any', ({ who, params, body }) => {
    admin(who);
    if (body.status) return service.setEventStatus(who, params.id, body.status);
    return service.updateEvent({ id: 'admin', role: 'PLATFORM_ADMIN', status: 'ACTIVE', permissions: {} }, params.id, body);
  });
  on('GET', '/api/admin/settings', 'any', ({ who }) => (admin(who), maskSettings(service.settings)));
  on('PUT', '/api/admin/settings', 'any', ({ who, body }) => {
    admin(who);
    const s = service.settings;
    if (body.payments?.provider && ['mock', 'transbank', 'mercadopago'].includes(body.payments.provider)) s.payments.provider = body.payments.provider;
    for (const [name, creds] of Object.entries(body.payments?.providers ?? {})) {
      if (!s.payments.providers[name]) continue;
      for (const [k, v] of Object.entries(creds)) if (typeof v === 'string' && v !== '••••') s.payments.providers[name][k] = v;
    }
    if (body.pricing) {
      const p = body.pricing;
      if (typeof p.hostCanSetPrice === 'boolean') s.pricing.hostCanSetPrice = p.hostCanSetPrice;
      for (const k of ['minimumCardPrice', 'maximumCardPrice', 'fixedCardPrice']) if (p[k] !== undefined) s.pricing[k] = Math.max(0, Number(p[k]) || 0);
      if (p.defaultCurrency) s.pricing.defaultCurrency = String(p.defaultCurrency).slice(0, 3).toUpperCase();
    }
    if (body.limits) for (const k of ['maxEventCapacity', 'maxCardsPerPlayer']) if (body.limits[k] !== undefined) s.limits[k] = Math.max(1, Number(body.limits[k]) || s.limits[k]);
    if (body.commission?.platformFeePct !== undefined) s.commission.platformFeePct = Math.max(0, Math.min(100, Number(body.commission.platformFeePct) || 0));
    store.save();
    store.audit('admin', 'settings.update');
    return maskSettings(s);
  });
  on('GET', '/api/admin/promotions', 'any', ({ who }) => (admin(who), store.list('promotions')));
  on('POST', '/api/admin/promotions', 'any', ({ who, body }) => (admin(who), service.createPromotion(who, body)));
  on('POST', '/api/admin/cards/complimentary', 'any', ({ who, body }) => (admin(who), { cards: service.grantCards(who, body.eventId, body.playerId, body.quantity, body.acquisitionType) }));
  on('GET', '/api/admin/orders', 'any', ({ who }) => (admin(who), store.list('orders')));
  on('POST', '/api/admin/orders/:id/refund', 'any', ({ who, params }) => (admin(who), service.refundOrder(who, params.id)));
  on('GET', '/api/admin/players', 'any', ({ who }) => (admin(who), store.list('players').map(({ tokenHash: _t, ...p }) => p)));

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    if (!url.pathname.startsWith('/api/')) return false;
    const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!route) {
      send(res, 404, { error: 'not-found', message: 'Ruta no encontrada' });
      return true;
    }
    try {
      const m = url.pathname.match(route.re);
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const auth = String(req.headers.authorization || '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const who = identify(store, token, adminTokenHash);
      const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req);
      const query = Object.fromEntries(url.searchParams);
      const result = await route.handler({ who, params, body, headers: req.headers, query });
      send(res, 200, result ?? {});
    } catch (err) {
      const status = err instanceof PlatformError ? err.status : 500;
      if (status === 500) console.error('API error', err);
      send(res, status, { error: err.code ?? 'internal', message: err.message });
    }
    return true;
  };
}
