/** Retorno de pago (#/pay?order=…): el estado lo decide el servidor; con el proveedor de pruebas se puede simular el webhook. */

import { button, clear, errorMessage, h, toast } from '../../dom.js';
import { navigate } from '../../router.js';
import { formatMoney, playerApi, resolveServer, type Order } from '../api.js';

export async function renderPay(root: HTMLElement, params: URLSearchParams): Promise<void> {
  clear(root);
  const orderId = params.get('order') ?? '';
  const paymentId = params.get('payment') ?? '';
  await resolveServer(params.get('l'));
  if (!orderId) {
    root.appendChild(h('section', { class: 'panel' }, h('p', { class: 'alert alert-error' }, 'Falta la orden.'), button('Inicio', () => navigate('/'), 'btn')));
    return;
  }
  const panel = h('section', { class: 'panel center' }, h('h1', null, '🎟 Tu compra'), h('p', { class: 'muted' }, 'Comprobando el estado del pago…'));
  root.appendChild(panel);
  let info: { paymentProvider: string; mockPayments: boolean } | null = null;
  try {
    info = await playerApi.info();
  } catch {
    /* sin info */
  }
  let attempts = 0;
  const draw = (order: Order, cards: { index: number }[]) => {
    clear(panel);
    panel.appendChild(h('h1', null, '🎟 Tu compra'));
    panel.appendChild(h('p', null, `${order.quantity} tarjeta(s) · ${formatMoney(order.total, order.currency)}`));
    if (order.status === 'PAID') {
      panel.appendChild(h('h2', { class: 'ok' }, '✅ COMPRA APROBADA'));
      panel.appendChild(h('p', { class: 'muted' }, cards.length > 1 ? 'Tus tarjetas están listas.' : 'Tu tarjeta está lista.'));
      panel.appendChild(button('ENTRAR A BINGO HIT', () => navigate(`/play?e=${encodeURIComponent(order.eventId)}`), 'btn btn-primary btn-xl'));
      return true;
    }
    if (order.status === 'FAILED' || order.status === 'CANCELLED') {
      panel.appendChild(h('h2', { class: 'alert-error' }, '❌ El pago no se completó'));
      panel.appendChild(button('Volver a intentarlo', () => navigate(`/event?e=${encodeURIComponent(order.eventId)}`), 'btn btn-primary'));
      return true;
    }
    if (order.status === 'REFUNDED') {
      panel.appendChild(h('h2', null, 'Compra reembolsada'));
      return true;
    }
    panel.appendChild(h('p', { class: 'muted' }, '⏳ Esperando la confirmación del pago… (el servidor la recibe directamente del proveedor)'));
    if (info?.mockPayments && paymentId) {
      panel.appendChild(h('p', { class: 'alert alert-warn small' }, 'Proveedor de pruebas: simula la respuesta del gateway.'));
      panel.appendChild(
        h(
          'div',
          { class: 'actions center' },
          button('Simular pago aprobado', () => void playerApi.simulateMock(paymentId, 'approved').then(poll, (err) => toast(errorMessage(err), 'error')), 'btn btn-primary'),
          button('Simular pago rechazado', () => void playerApi.simulateMock(paymentId, 'rejected').then(poll, (err) => toast(errorMessage(err), 'error')), 'btn'),
        ),
      );
    }
    return false;
  };
  const poll = async () => {
    try {
      const r = await playerApi.orderStatus(orderId);
      if (draw(r.order, r.cards)) return;
      if (++attempts < 120 && panel.isConnected) setTimeout(() => void poll(), 2500);
    } catch (err) {
      clear(panel);
      panel.appendChild(h('p', { class: 'alert alert-error' }, errorMessage(err)));
      panel.appendChild(button('Inicio', () => navigate('/'), 'btn'));
    }
  };
  await poll();
}
