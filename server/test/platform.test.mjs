/** Pruebas de la plataforma (roles, eventos, FREE/PAID, pagos idempotentes, acceso) con http nativo. Requiere `npm run build`. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { createPlatformApi } from '../platform/api.mjs';
import { PlatformService } from '../platform/service.mjs';
import { Store } from '../platform/store.mjs';

async function boot() {
  const store = new Store(null);
  const service = new PlatformService(store, { env: { MOCK_PAYMENT_SECRET: 'test-secret' }, appUrl: 'http://app/', apiUrl: 'http://api', liveState: () => ({ concurrentPlayers: 3, liveEvents: 1 }) });
  const handle = createPlatformApi(service, { adminToken: 'admin-token' });
  const server = createServer((req, res) => {
    handle(req, res).then((done) => {
      if (!done) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  return { store, service, server, call };
}

test('roles y permisos: solo el admin crea animadores; permisos validados en el servidor', async () => {
  const { server, call } = await boot();
  assert.equal((await call('GET', '/api/admin/stats')).status, 401);
  assert.equal((await call('GET', '/api/admin/stats', { token: 'wrong' })).status, 401);
  const created = await call('POST', '/api/admin/hosts', { token: 'admin-token', body: { name: 'DJ Ana', email: 'ana@x.cl' } });
  assert.equal(created.status, 200);
  const hostToken = created.data.token;
  assert.match(hostToken, /^host_/);
  assert.equal(created.data.user.permissions.canCreatePaidEvents, false);
  assert.equal((await call('POST', '/api/admin/hosts', { token: hostToken, body: { name: 'X' } })).status, 403, 'un animador no crea animadores');
  const me = await call('GET', '/api/host/me', { token: hostToken });
  assert.equal(me.data.name, 'DJ Ana');
  // Sin permiso de eventos pagados
  const paid = await call('POST', '/api/host/events', { token: hostToken, body: { name: 'Fiesta', eventMode: 'ONLINE', cardDistribution: 'PAID' } });
  assert.equal(paid.status, 403);
  assert.equal(paid.data.error, 'permission');
  // Híbrido sin permiso
  assert.equal((await call('POST', '/api/host/events', { token: hostToken, body: { name: 'H', eventMode: 'HYBRID', cardDistribution: 'FREE' } })).status, 403);
  // El admin concede permisos
  const upd = await call('PATCH', `/api/admin/hosts/${created.data.user.id}`, { token: 'admin-token', body: { permissions: { canCreatePaidEvents: true, canCreateHybridEvents: true } } });
  assert.equal(upd.data.permissions.canCreatePaidEvents, true);
  const ok = await call('POST', '/api/host/events', { token: hostToken, body: { name: 'Fiesta', eventMode: 'ONLINE', cardDistribution: 'PAID', paid: { pricePerCard: 999 } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.paid.pricePerCard, 3000, 'sin hostCanSetPrice se usa el precio fijo de la plataforma');
  assert.equal(ok.data.liveRoomId, `bingo-${ok.data.id}`);
  assert.equal(ok.data.status, 'DRAFT');
  // Suspender animador
  await call('PATCH', `/api/admin/hosts/${created.data.user.id}`, { token: 'admin-token', body: { status: 'SUSPENDED' } });
  assert.equal((await call('GET', '/api/host/events', { token: hostToken })).status, 403);
  server.closeAllConnections();
  server.close();
});

test('modalidad y distribución desacopladas: LOCAL/ONLINE/HYBRID × FREE/PAID', async () => {
  const { server, call } = await boot();
  const { data: h } = await call('POST', '/api/admin/hosts', { token: 'admin-token', body: { name: 'H', permissions: { canCreatePaidEvents: true, canCreateHybridEvents: true } } });
  for (const eventMode of ['LOCAL', 'ONLINE', 'HYBRID']) {
    for (const cardDistribution of ['FREE', 'PAID']) {
      const r = await call('POST', '/api/host/events', { token: h.token, body: { name: `${eventMode} ${cardDistribution}`, eventMode, cardDistribution } });
      assert.equal(r.status, 200, `${eventMode}+${cardDistribution}`);
      assert.equal(r.data.eventMode, eventMode);
      assert.equal(r.data.cardDistribution, cardDistribution);
      await call('POST', `/api/host/events/${r.data.id}/publish`, { token: h.token });
      const pub = (await call('GET', `/api/events/${r.data.id}`)).data;
      assert.equal(pub.liveStreamingEnabled, eventMode !== 'LOCAL');
      assert.equal(pub.checkoutRequired, cardDistribution === 'PAID');
    }
  }
  const hybrid = await call('POST', '/api/host/events', { token: h.token, body: { name: 'Hy', eventMode: 'HYBRID', cardDistribution: 'PAID', localCardDistribution: 'FREE', remoteCardDistribution: 'PAID' } });
  assert.equal(hybrid.data.localCardDistribution, 'FREE');
  assert.equal(hybrid.data.remoteCardDistribution, 'PAID');
  server.closeAllConnections();
  server.close();
});

test('ONLINE + FREE: tarjeta sin checkout, límites y acceso centralizado', async () => {
  const { server, call, service } = await boot();
  const { data: h } = await call('POST', '/api/admin/hosts', { token: 'admin-token', body: { name: 'H' } });
  const ev = (await call('POST', '/api/host/events', { token: h.token, body: { name: 'Gratis', eventMode: 'ONLINE', cardDistribution: 'FREE', capacity: 3, free: { maxCardsPerPlayer: 2 }, game: { tracks: [['A', 'a'], ['B', 'b'], ['C', 'c'], ['D', 'd'], ['E', 'e'], ['F', 'f'], ['G', 'g'], ['H', 'h'], ['I', 'i']], gridSize: 3, freeCenter: false }, startsAt: new Date(Date.now() + 3600e3).toISOString() } })).data;
  const p = (await call('POST', '/api/players', { body: { name: 'Marta' } })).data;
  // Borrador: no se puede
  assert.equal((await call('POST', `/api/events/${ev.id}/cards/free`, { token: p.token, body: {} })).status, 409);
  await call('POST', `/api/host/events/${ev.id}/publish`, { token: h.token });
  const denied = (await call('GET', `/api/events/${ev.id}/access`, { token: p.token })).data;
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'card-required');
  const got = await call('POST', `/api/events/${ev.id}/cards/free`, { token: p.token, body: { quantity: 1 } });
  assert.equal(got.status, 200);
  assert.equal(got.data.cards[0].acquisitionType, 'FREE');
  assert.equal(got.data.cards[0].index, 0);
  const access = (await call('GET', `/api/events/${ev.id}/access`, { token: p.token })).data;
  assert.equal(access.allowed, true);
  assert.equal(access.waiting, true, 'el evento aún no ha empezado: conserva la tarjeta y espera');
  assert.equal(access.game.poolSize, 9);
  assert.equal(access.live.streaming, true);
  assert.equal(access.cards.length, 1);
  // Máximo por jugador
  assert.equal((await call('POST', `/api/events/${ev.id}/cards/free`, { token: p.token, body: { quantity: 2 } })).status, 409);
  assert.equal((await call('POST', `/api/events/${ev.id}/cards/free`, { token: p.token, body: { quantity: 1 } })).status, 200);
  // Capacidad total 3
  const p2 = (await call('POST', '/api/players', { body: { name: 'Luis' } })).data;
  assert.equal((await call('POST', `/api/events/${ev.id}/cards/free`, { token: p2.token, body: { quantity: 1 } })).status, 200);
  const p3 = (await call('POST', '/api/players', { body: { name: 'Eva' } })).data;
  const soldOut = await call('POST', `/api/events/${ev.id}/cards/free`, { token: p3.token, body: {} });
  assert.equal(soldOut.data.error, 'sold-out');
  // Recuperación de tarjetas por token
  const me = (await call('GET', '/api/me', { token: p.token })).data;
  assert.equal(me.cards.length, 2);
  // Ninguna orden ni pago creados
  assert.equal(service.store.list('orders').length, 0);
  assert.equal(service.store.list('payments').length, 0);
  // Suspensión del evento por el admin bloquea el acceso
  await call('PATCH', `/api/admin/events/${ev.id}`, { token: 'admin-token', body: { status: 'SUSPENDED' } });
  assert.equal((await call('GET', `/api/events/${ev.id}/access`, { token: p.token })).data.reason, 'event-suspended');
  const stats = (await call('GET', `/api/host/events/${ev.id}/stats`, { token: h.token })).data;
  assert.equal(stats.cardsFree, 3);
  assert.equal(stats.grossSales, 0);
  server.closeAllConnections();
  server.close();
});

test('ONLINE + PAID: orden PENDING, webhook firmado e idempotente, tarjetas tras el pago, reembolso', async () => {
  const { server, call, service } = await boot();
  const { data: h } = await call('POST', '/api/admin/hosts', { token: 'admin-token', body: { name: 'H', permissions: { canCreatePaidEvents: true } } });
  await call('PUT', '/api/admin/settings', { token: 'admin-token', body: { pricing: { fixedCardPrice: 2500 }, commission: { platformFeePct: 10 } } });
  const ev = (await call('POST', '/api/host/events', { token: h.token, body: { name: 'Pagado', eventMode: 'ONLINE', cardDistribution: 'PAID', paid: { maxCardsPerPlayer: 3 }, game: { tracks: [['A', 'a'], ['B', 'b'], ['C', 'c'], ['D', 'd'], ['E', 'e'], ['F', 'f'], ['G', 'g'], ['H', 'h'], ['I', 'i']], gridSize: 3, freeCenter: false } } })).data;
  await call('POST', `/api/host/events/${ev.id}/publish`, { token: h.token });
  const p = (await call('POST', '/api/players', { body: { name: 'Pedro', contact: 'pedro@x.cl' } })).data;
  assert.equal((await call('POST', `/api/events/${ev.id}/cards/free`, { token: p.token, body: {} })).status, 402, 'FREE no aplica en evento PAID');
  const order = await call('POST', `/api/events/${ev.id}/orders`, { token: p.token, body: { quantity: 2 } });
  assert.equal(order.status, 200);
  assert.equal(order.data.order.status, 'PENDING');
  assert.equal(order.data.order.total, 5000);
  assert.match(order.data.redirectUrl, /#\/pay\?order=/);
  const paymentId = order.data.paymentId;
  // Sin pagar no hay acceso ni tarjetas; PENDING no cuenta como ingreso
  assert.equal((await call('GET', `/api/events/${ev.id}/access`, { token: p.token })).data.reason, 'purchase-required');
  assert.equal((await call('GET', `/api/host/events/${ev.id}/stats`, { token: h.token })).data.grossSales, 0);
  // Webhook con firma falsa
  const payment = service.store.get('payments', paymentId);
  const bad = await call('POST', '/api/payments/mock/webhook', { body: { eventId: 'x', providerTransactionId: payment.providerTransactionId, status: 'PAID', signature: 'nope' } });
  assert.equal(bad.status, 500 - 0 === 500 ? bad.status : 0);
  assert.notEqual(service.store.get('orders', order.data.order.id).status, 'PAID');
  // Webhook legítimo (simulado como lo haría el gateway) dos veces → una sola emisión de tarjetas
  const first = await call('POST', '/api/payments/mock/simulate', { body: { paymentId, result: 'approved' } });
  assert.equal(first.status, 200);
  assert.equal(first.data.results[0].cards.length, 2);
  const again = await call('POST', '/api/payments/mock/simulate', { body: { paymentId, result: 'approved' } });
  assert.equal(again.data.results[0].duplicate, true);
  assert.equal(service.store.list('cards', (c) => c.orderId === order.data.order.id).length, 2, 'sin duplicados');
  const paidOrder = (await call('GET', `/api/orders/${order.data.order.id}`, { token: p.token })).data;
  assert.equal(paidOrder.order.status, 'PAID');
  assert.equal(paidOrder.cards.length, 2);
  assert.equal((await call('GET', `/api/orders/${order.data.order.id}`)).status, 401, 'la orden no es pública');
  const access = (await call('GET', `/api/events/${ev.id}/access`, { token: p.token })).data;
  assert.equal(access.allowed, true);
  assert.equal(access.cards.length, 2);
  assert.equal(access.cards[0].acquisitionType, 'PURCHASE');
  const stats = (await call('GET', `/api/host/events/${ev.id}/stats`, { token: h.token })).data;
  assert.equal(stats.grossSales, 5000);
  assert.equal(stats.cardsPaid, 2);
  assert.equal(stats.platformRevenue, 500);
  assert.equal(stats.hostSettlement, 4500);
  // Máximo por jugador considera las ya compradas
  assert.equal((await call('POST', `/api/events/${ev.id}/orders`, { token: p.token, body: { quantity: 2 } })).data.error, 'max-per-player');
  // Reembolso solo admin; revoca tarjetas
  assert.equal((await call('POST', `/api/admin/orders/${order.data.order.id}/refund`, { token: h.token })).status, 403);
  const refund = await call('POST', `/api/admin/orders/${order.data.order.id}/refund`, { token: 'admin-token' });
  assert.equal(refund.data.status, 'REFUNDED');
  assert.equal((await call('GET', `/api/events/${ev.id}/access`, { token: p.token })).data.allowed, false);
  const global = (await call('GET', '/api/admin/stats', { token: 'admin-token' })).data;
  assert.equal(global.refunds, 5000);
  assert.equal(global.concurrentPlayers, 3);
  assert.equal(global.perHost[0].grossSales, 0);
  // Pago rechazado
  const p2 = (await call('POST', '/api/players', { body: { name: 'Rosa' } })).data;
  const o2 = (await call('POST', `/api/events/${ev.id}/orders`, { token: p2.token, body: { quantity: 1 } })).data;
  await call('POST', '/api/payments/mock/simulate', { body: { paymentId: o2.paymentId, result: 'rejected' } });
  assert.equal(service.store.get('orders', o2.order.id).status, 'FAILED');
  assert.equal((await call('GET', `/api/host/events/${ev.id}/stats`, { token: h.token })).data.ordersFailed, 1);
  server.closeAllConnections();
  server.close();
});

test('promociones y cortesías: una tarjeta válida no necesita Payment', async () => {
  const { server, call } = await boot();
  const { data: h } = await call('POST', '/api/admin/hosts', { token: 'admin-token', body: { name: 'H', permissions: { canCreatePaidEvents: true } } });
  const ev = (await call('POST', '/api/host/events', { token: h.token, body: { name: 'Pagado', eventMode: 'LOCAL', cardDistribution: 'PAID', game: { tracks: [['A', 'a'], ['B', 'b'], ['C', 'c'], ['D', 'd'], ['E', 'e'], ['F', 'f'], ['G', 'g'], ['H', 'h'], ['I', 'i']], gridSize: 3 } } })).data;
  await call('POST', `/api/host/events/${ev.id}/publish`, { token: h.token });
  await call('POST', '/api/admin/promotions', { token: 'admin-token', body: { code: 'vip', type: 'FREE_CARDS', value: 1, maxUses: 1 } });
  await call('POST', '/api/admin/promotions', { token: 'admin-token', body: { code: 'MITAD', type: 'DISCOUNT_PCT', value: 50 } });
  const p = (await call('POST', '/api/players', { body: { name: 'Influencer' } })).data;
  const promo = await call('POST', `/api/events/${ev.id}/cards/free`, { token: p.token, body: { promoCode: 'VIP' } });
  assert.equal(promo.status, 200);
  assert.equal(promo.data.cards[0].acquisitionType, 'PROMO');
  const p2 = (await call('POST', '/api/players', { body: { name: 'Otro' } })).data;
  assert.equal((await call('POST', `/api/events/${ev.id}/cards/free`, { token: p2.token, body: { promoCode: 'VIP' } })).data.error, 'promo', 'código agotado');
  const disc = (await call('POST', `/api/events/${ev.id}/orders`, { token: p2.token, body: { quantity: 1, promoCode: 'mitad' } })).data;
  assert.equal(disc.order.discount, 1500);
  assert.equal(disc.order.total, 1500);
  const comp = await call('POST', '/api/admin/cards/complimentary', { token: 'admin-token', body: { eventId: ev.id, playerId: p2.player.id, quantity: 2 } });
  assert.equal(comp.data.cards.length, 2);
  assert.equal(comp.data.cards[0].acquisitionType, 'COMPLIMENTARY');
  assert.equal((await call('GET', `/api/events/${ev.id}/access`, { token: p2.token })).data.allowed, true);
  server.closeAllConnections();
  server.close();
});

test('configuración: las credenciales nunca se devuelven en claro', async () => {
  const { server, call } = await boot();
  await call('PUT', '/api/admin/settings', { token: 'admin-token', body: { payments: { provider: 'mercadopago', providers: { mercadopago: { accessToken: 'APP-123' } } } } });
  const s = (await call('GET', '/api/admin/settings', { token: 'admin-token' })).data;
  assert.equal(s.payments.provider, 'mercadopago');
  assert.equal(s.payments.providers.mercadopago.accessToken, '••••');
  assert.equal((await call('GET', '/api/platform/info')).data.paymentProvider, 'mercadopago');
  assert.equal((await call('GET', '/api/platform/info')).data.mockPayments, false);
  server.closeAllConnections();
  server.close();
});
