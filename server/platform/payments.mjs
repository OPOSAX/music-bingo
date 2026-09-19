/**
 * Pagos centralizados de la plataforma Bingo Hit (PlatformPaymentService).
 * El animador nunca configura un gateway: las credenciales viven en la configuración de plataforma
 * (o en variables de entorno) y el backend es la única fuente de verdad del estado del pago.
 *
 * Interfaz común de proveedor:
 *   createPayment(order, ctx) → { providerTransactionId, redirectUrl?, clientData? }
 *   confirmPayment(payment, data) → { status: 'PAID'|'FAILED'|'PENDING', providerTransactionId }
 *   getPaymentStatus(payment) → { status }
 *   handleWebhook(req: { headers, body, query }) → { events: [{ eventId, providerTransactionId, status }] }
 *   refundPayment(payment, amount) → { status: 'REFUNDED'|'FAILED', providerRefundId? }
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Proveedor de pruebas: el "pago" se confirma solo mediante un webhook firmado con MOCK_PAYMENT_SECRET. */
export class MockProvider {
  constructor(options = {}) {
    this.name = 'mock';
    this.secret = options.secret || 'mock-secret';
    this.baseUrl = options.baseUrl || '';
  }
  async createPayment(order, ctx) {
    const providerTransactionId = `mock_${order.id}`;
    return { providerTransactionId, redirectUrl: `${ctx.appUrl}#/pay?order=${encodeURIComponent(order.id)}&payment=${encodeURIComponent(ctx.paymentId)}` };
  }
  sign(payload) {
    return createHmac('sha256', this.secret).update(JSON.stringify(payload)).digest('hex');
  }
  async confirmPayment(payment) {
    return { status: payment.status, providerTransactionId: payment.providerTransactionId };
  }
  async getPaymentStatus(payment) {
    return { status: payment.status };
  }
  async handleWebhook(req) {
    const body = req.body || {};
    const signature = String(req.headers['x-mock-signature'] || body.signature || '');
    const payload = { eventId: body.eventId, providerTransactionId: body.providerTransactionId, status: body.status };
    const expected = this.sign(payload);
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Firma de webhook inválida');
    return { events: [payload] };
  }
  async refundPayment(payment) {
    return { status: 'REFUNDED', providerRefundId: `refund_${payment.providerTransactionId}` };
  }
}

/**
 * Transbank Webpay Plus (REST). Requiere commerceCode + apiKey (Tbk-Api-Key-Id / Tbk-Api-Key-Secret).
 * Flujo: create → redirección del jugador con token_ws → return_url → commit (PUT) en el backend.
 * Pendiente de validar contra el ambiente de integración de Transbank.
 */
export class TransbankProvider {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.name = 'transbank';
    this.config = config;
    this.fetch = fetchImpl;
    this.base = config.environment === 'production' ? 'https://webpay3g.transbank.cl' : 'https://webpay3gint.transbank.cl';
  }
  headers() {
    return { 'Tbk-Api-Key-Id': this.config.commerceCode, 'Tbk-Api-Key-Secret': this.config.apiKey, 'Content-Type': 'application/json' };
  }
  async createPayment(order, ctx) {
    const res = await this.fetch(`${this.base}/rswebpaytransaction/api/webpay/v1.2/transactions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ buy_order: order.id, session_id: order.playerId, amount: order.total, return_url: `${ctx.apiUrl}/api/payments/transbank/return` }),
    });
    if (!res.ok) throw new Error(`Transbank create: HTTP ${res.status}`);
    const data = await res.json();
    return { providerTransactionId: data.token, redirectUrl: `${data.url}?token_ws=${data.token}` };
  }
  async confirmPayment(payment, data) {
    const token = data?.token_ws || payment.providerTransactionId;
    const res = await this.fetch(`${this.base}/rswebpaytransaction/api/webpay/v1.2/transactions/${encodeURIComponent(token)}`, { method: 'PUT', headers: this.headers() });
    if (!res.ok) return { status: 'FAILED', providerTransactionId: token };
    const tx = await res.json();
    return { status: tx.status === 'AUTHORIZED' && tx.response_code === 0 ? 'PAID' : 'FAILED', providerTransactionId: token, raw: { authorization_code: tx.authorization_code, amount: tx.amount } };
  }
  async getPaymentStatus(payment) {
    const res = await this.fetch(`${this.base}/rswebpaytransaction/api/webpay/v1.2/transactions/${encodeURIComponent(payment.providerTransactionId)}`, { headers: this.headers() });
    if (!res.ok) return { status: 'PENDING' };
    const tx = await res.json();
    return { status: tx.status === 'AUTHORIZED' ? 'PAID' : tx.status === 'INITIALIZED' ? 'PENDING' : 'FAILED' };
  }
  /** Transbank no envía webhooks: la confirmación llega por el return_url y se cierra con commit (confirmPayment). */
  async handleWebhook(req) {
    const token = req.query?.token_ws || req.body?.token_ws;
    if (!token) return { events: [] };
    const result = await this.confirmPayment({ providerTransactionId: token }, { token_ws: token });
    return { events: [{ eventId: `tbk_${token}`, providerTransactionId: token, status: result.status }] };
  }
  async refundPayment(payment, amount) {
    const res = await this.fetch(`${this.base}/rswebpaytransaction/api/webpay/v1.2/transactions/${encodeURIComponent(payment.providerTransactionId)}/refunds`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ amount }) });
    if (!res.ok) return { status: 'FAILED' };
    const data = await res.json();
    return { status: data.type === 'REVERSED' || data.type === 'NULLIFIED' ? 'REFUNDED' : 'FAILED', providerRefundId: data.authorization_code };
  }
}

/**
 * Mercado Pago (Checkout Pro). Requiere accessToken; los webhooks se verifican consultando /v1/payments/{id}
 * con el token (nunca se confía en el cuerpo del webhook por sí solo).
 */
export class MercadoPagoProvider {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.name = 'mercadopago';
    this.config = config;
    this.fetch = fetchImpl;
    this.base = 'https://api.mercadopago.com';
  }
  headers() {
    return { Authorization: `Bearer ${this.config.accessToken}`, 'Content-Type': 'application/json' };
  }
  async createPayment(order, ctx) {
    const res = await this.fetch(`${this.base}/checkout/preferences`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        external_reference: order.id,
        items: [{ title: `Tarjeta Bingo Hit × ${order.quantity}`, quantity: 1, unit_price: order.total, currency_id: order.currency }],
        back_urls: { success: `${ctx.appUrl}#/pay?order=${order.id}`, failure: `${ctx.appUrl}#/pay?order=${order.id}`, pending: `${ctx.appUrl}#/pay?order=${order.id}` },
        notification_url: `${ctx.apiUrl}/api/payments/mercadopago/webhook`,
        auto_return: 'approved',
      }),
    });
    if (!res.ok) throw new Error(`Mercado Pago preference: HTTP ${res.status}`);
    const pref = await res.json();
    return { providerTransactionId: pref.id, redirectUrl: pref.init_point };
  }
  async lookupPayment(paymentId) {
    const res = await this.fetch(`${this.base}/v1/payments/${encodeURIComponent(paymentId)}`, { headers: this.headers() });
    if (!res.ok) return null;
    return res.json();
  }
  async confirmPayment(payment, data) {
    const mp = data?.paymentId ? await this.lookupPayment(data.paymentId) : null;
    if (!mp) return { status: 'PENDING', providerTransactionId: payment.providerTransactionId };
    return { status: mp.status === 'approved' ? 'PAID' : mp.status === 'rejected' || mp.status === 'cancelled' ? 'FAILED' : 'PENDING', providerTransactionId: payment.providerTransactionId, orderRef: mp.external_reference };
  }
  async getPaymentStatus(payment) {
    return { status: payment.status };
  }
  async handleWebhook(req) {
    const id = req.body?.data?.id || req.query?.['data.id'] || req.query?.id;
    if (!id) return { events: [] };
    const mp = await this.lookupPayment(id);
    if (!mp) return { events: [] };
    const status = mp.status === 'approved' ? 'PAID' : mp.status === 'rejected' || mp.status === 'cancelled' ? 'FAILED' : 'PENDING';
    return { events: [{ eventId: `mp_${id}`, providerTransactionId: mp.order?.id ? String(mp.order.id) : undefined, orderRef: mp.external_reference, status }] };
  }
  async refundPayment(payment) {
    const res = await this.fetch(`${this.base}/v1/payments/${encodeURIComponent(payment.providerPaymentId || payment.providerTransactionId)}/refunds`, { method: 'POST', headers: this.headers(), body: '{}' });
    if (!res.ok) return { status: 'FAILED' };
    const data = await res.json();
    return { status: data.status === 'approved' ? 'REFUNDED' : 'FAILED', providerRefundId: String(data.id) };
  }
}

/** Elige el proveedor configurado por la plataforma (settings) con posibilidad de override por entorno. */
export function providerFromSettings(settings, env = {}) {
  const name = env.PAYMENT_PROVIDER || settings.payments.provider || 'mock';
  if (name === 'transbank') {
    const c = settings.payments.providers.transbank;
    return new TransbankProvider({ commerceCode: env.TRANSBANK_COMMERCE_CODE || c.commerceCode, apiKey: env.TRANSBANK_API_KEY || c.apiKey, environment: env.TRANSBANK_ENV || c.environment });
  }
  if (name === 'mercadopago') {
    const c = settings.payments.providers.mercadopago;
    return new MercadoPagoProvider({ accessToken: env.MERCADOPAGO_ACCESS_TOKEN || c.accessToken, webhookSecret: env.MERCADOPAGO_WEBHOOK_SECRET || c.webhookSecret });
  }
  return new MockProvider({ secret: env.MOCK_PAYMENT_SECRET || 'mock-secret' });
}
