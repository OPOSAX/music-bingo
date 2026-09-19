/** Landing pública de un evento (#/event?e=ID): información, GRATIS o precio, identificación mínima y obtener/comprar tarjetas. */

import { button, clear, errorMessage, h, toast } from '../../dom.js';
import { navigate } from '../../router.js';
import { ApiError, formatMoney, formatWhen, playerApi, resolveServer, tokens, type PublicEvent } from '../api.js';

const MODE_LABEL: Record<string, string> = { LOCAL: 'Presencial', ONLINE: 'Online', HYBRID: 'Híbrido' };

export async function renderEvent(root: HTMLElement, params: URLSearchParams): Promise<void> {
  clear(root);
  const id = params.get('e') ?? '';
  const server = await resolveServer(params.get('l'));
  if (!id || !server) {
    root.appendChild(h('section', { class: 'panel' }, h('p', { class: 'alert alert-error' }, 'Falta el evento o el servidor en el enlace.'), button('Inicio', () => navigate('/'), 'btn')));
    return;
  }
  let event: PublicEvent;
  try {
    event = await playerApi.event(id);
  } catch (err) {
    root.appendChild(h('section', { class: 'panel' }, h('p', { class: 'alert alert-error' }, errorMessage(err)), button('Inicio', () => navigate('/'), 'btn')));
    return;
  }
  const paid = event.cardDistribution === 'PAID';
  const hero = h(
    'section',
    { class: 'event-hero' },
    event.coverUrl ? h('img', { class: 'event-cover', src: event.coverUrl, alt: '' }) : null,
    h('div', { class: 'event-head' }, h('span', { class: `live-badge ${event.status === 'LIVE' ? 'live-on' : 'live-off'}` }, event.status === 'LIVE' ? '🔴 EN VIVO' : 'BINGO HIT'), h('h1', null, event.name), h('p', { class: 'lead' }, `📅 ${formatWhen(event.startsAt)}`)),
  );
  root.appendChild(hero);
  const facts = h(
    'section',
    { class: 'panel' },
    h('div', { class: 'event-facts' }, fact('🎵', `${event.songCount || '—'} canciones`), fact('📍', MODE_LABEL[event.eventMode] ?? event.eventMode), fact(paid ? '🎟' : '🆓', paid && event.price ? `${formatMoney(event.price.pricePerCard, event.price.currency)} por tarjeta` : 'ENTRADA GRATIS'), fact('👥', `${event.availableCards} tarjetas disponibles`)),
    event.prizes ? h('p', null, h('strong', null, '🏆 Premios: '), event.prizes) : null,
    event.description ? h('p', { class: 'muted' }, event.description) : null,
    event.rules ? h('details', null, h('summary', null, 'Reglas'), h('p', { class: 'muted small' }, event.rules)) : null,
    event.hostName ? h('p', { class: 'small muted' }, `Animador: ${event.hostName}`) : null,
  );
  root.appendChild(facts);
  const countdown = renderCountdown(event.startsAt);
  if (countdown) root.appendChild(countdown);

  const action = h('section', { class: 'panel' });
  root.appendChild(action);
  if (!['PUBLISHED', 'LIVE'].includes(event.status)) {
    action.appendChild(h('p', { class: 'alert alert-warn' }, event.status === 'FINISHED' ? 'Este evento ya terminó.' : 'Este evento no está disponible ahora mismo.'));
    return;
  }
  // Si ya tiene tarjeta, directo a jugar.
  if (tokens.player()) {
    try {
      const access = await playerApi.access(event.id);
      if (access.allowed) {
        action.appendChild(h('p', { class: 'ok' }, `✅ Ya tienes ${access.cards?.length ?? 1} tarjeta(s) para este evento.`));
        action.appendChild(button('ENTRAR A BINGO HIT', () => navigate(`/play?e=${encodeURIComponent(event.id)}`), 'btn btn-primary btn-xl'));
        if (event.availableCards > 0 && (access.cards?.length ?? 0) < (paid ? (event.price?.maxCardsPerPlayer ?? 1) : (event.free?.maxCardsPerPlayer ?? 1))) action.appendChild(h('p', { class: 'small muted center' }, 'Puedes conseguir más tarjetas abajo.'));
        else return;
      }
    } catch {
      /* token caducado o servidor distinto: identificación de nuevo */
    }
  }
  action.appendChild(renderAcquire(event));
}

function fact(icon: string, text: string): HTMLElement {
  return h('div', { class: 'event-fact' }, h('span', { class: 'event-fact-icon' }, icon), h('span', null, text));
}

function renderCountdown(startsAt: string | null): HTMLElement | null {
  if (!startsAt || Date.parse(startsAt) <= Date.now()) return null;
  const el = h('section', { class: 'panel center countdown' }, h('p', { class: 'muted small' }, 'Bingo Hit comienza en'), h('div', { class: 'countdown-clock' }, '--:--:--'));
  const clock = el.querySelector('.countdown-clock') as HTMLElement;
  const tick = () => {
    const ms = Date.parse(startsAt) - Date.now();
    if (ms <= 0) {
      clock.textContent = '¡Ya empezó!';
      return;
    }
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    clock.textContent = `${d ? `${d}d ` : ''}${String(Math.floor((s % 86400) / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  const timer = setInterval(() => {
    if (!el.isConnected) clearInterval(timer);
    else tick();
  }, 1000);
  return el;
}

function renderAcquire(event: PublicEvent): HTMLElement {
  const paid = event.cardDistribution === 'PAID';
  const max = paid ? (event.price?.maxCardsPerPlayer ?? 1) : (event.free?.maxCardsPerPlayer ?? 1);
  const name = h('input', { class: 'input', type: 'text', placeholder: 'Tu nombre o alias', maxLength: 40, value: tokens.playerName(), autocomplete: 'name' });
  const contact = h('input', { class: 'input', type: 'text', placeholder: paid ? 'Email o teléfono (para tu comprobante)' : 'Email o teléfono (opcional)', maxLength: 120, autocomplete: 'email' });
  const promo = h('input', { class: 'input', type: 'text', placeholder: 'Código promocional (opcional)', maxLength: 30, autocomplete: 'off' });
  let qty = 1;
  const qtyLabel = h('strong', { class: 'qty-value' }, '1');
  const total = h('p', { class: 'order-total' });
  const updateTotal = () => {
    qtyLabel.textContent = String(qty);
    if (paid && event.price) total.textContent = `TOTAL: ${formatMoney(event.price.pricePerCard * qty, event.price.currency)}`;
  };
  updateTotal();
  const qtyRow = h('div', { class: 'qty-row' }, button('−', () => { qty = Math.max(1, qty - 1); updateTotal(); }, 'btn qty-btn'), qtyLabel, button('+', () => { qty = Math.min(max, qty + 1); updateTotal(); }, 'btn qty-btn'), h('span', { class: 'small muted' }, paid && event.price ? `${formatMoney(event.price.pricePerCard, event.price.currency)} cada una · máx. ${max}` : `máx. ${max} por persona`));
  const submit = h('button', { class: 'btn btn-primary btn-xl', type: 'submit' }, paid ? '🎟 COMPRAR Y JUGAR' : '🎫 OBTENER MI TARJETA');
  const status = h('p', { class: 'small muted center' });
  const form = h('form', { class: 'acquire' }, h('h2', null, paid ? 'Tus tarjetas' : 'Entrada gratis'), max > 1 ? qtyRow : null, paid ? total : null, h('div', { class: 'fields' }, h('label', { class: 'field' }, 'Nombre', name), h('label', { class: 'field' }, 'Contacto', contact), h('label', { class: 'field' }, 'Código promocional', promo)), submit, status, h('p', { class: 'small muted center' }, paid ? 'El pago lo procesa la plataforma Bingo Hit de forma segura.' : 'Sin registro: tu tarjeta queda guardada en este teléfono.'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const n = name.value.trim();
    if (!n) {
      toast('Escribe tu nombre.', 'error');
      return;
    }
    submit.disabled = true;
    status.textContent = paid ? 'Creando tu compra…' : 'Solicitando tu tarjeta…';
    try {
      if (!tokens.player() || tokens.playerName() !== n) {
        const me = await playerApi.identify(n, contact.value.trim());
        tokens.setPlayer(me.token, n);
      }
      const code = promo.value.trim() || undefined;
      if (paid && !code) {
        const r = await playerApi.order(event.id, qty, code);
        if (r.order.status === 'PAID') {
          navigate(`/pay?order=${encodeURIComponent(r.order.id)}`);
          return;
        }
        if (r.redirectUrl) {
          location.href = r.redirectUrl;
          return;
        }
        navigate(`/pay?order=${encodeURIComponent(r.order.id)}&payment=${encodeURIComponent(r.paymentId ?? '')}`);
        return;
      }
      if (paid && code) {
        // Con código: primero intentamos tarjetas gratis de promoción; si el código es de descuento, compra.
        try {
          await playerApi.freeCards(event.id, qty, code);
        } catch (err) {
          if (err instanceof ApiError && err.code === 'paid') {
            const r = await playerApi.order(event.id, qty, code);
            if (r.order.status !== 'PAID' && r.redirectUrl) {
              location.href = r.redirectUrl;
              return;
            }
            navigate(`/pay?order=${encodeURIComponent(r.order.id)}&payment=${encodeURIComponent(r.paymentId ?? '')}`);
            return;
          }
          throw err;
        }
      } else {
        await playerApi.freeCards(event.id, qty, code);
      }
      status.textContent = '';
      form.replaceChildren(h('div', { class: 'center' }, h('h2', null, '✅ Tu tarjeta está lista'), h('p', { class: 'muted' }, `${qty} tarjeta(s) a nombre de ${n}.`), button('ENTRAR A BINGO HIT', () => navigate(`/play?e=${encodeURIComponent(event.id)}`), 'btn btn-primary btn-xl')));
    } catch (err) {
      submit.disabled = false;
      status.textContent = '';
      toast(errorMessage(err), 'error');
    }
  });
  return form;
}
