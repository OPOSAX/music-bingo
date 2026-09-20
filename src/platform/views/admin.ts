/** Panel del Administrador General (#/admin): métricas globales, animadores y permisos, eventos, pagos, políticas y promociones. */

import { button, clear, errorMessage, h, toast } from '../../dom.js';
import { navigate } from '../../router.js';
import { adminApi, formatMoney, resolveServer, tokens } from '../api.js';
import { logout } from './login.js';

const PERMS: [string, string][] = [
  ['canCreateLocalEvents', 'Presencial'],
  ['canCreateOnlineEvents', 'Online'],
  ['canCreateHybridEvents', 'Híbrido'],
  ['canCreateFreeEvents', 'Tarjetas gratis'],
  ['canCreatePaidEvents', 'Tarjetas pagadas'],
  ['canSetCardPrice', 'Fijar precio'],
  ['canStartLive', 'Transmitir'],
];

export async function renderAdmin(root: HTMLElement, params: URLSearchParams): Promise<void> {
  clear(root);
  const server = await resolveServer(params.get('l'));
  if (!server || !tokens.admin()) {
    navigate('/login?next=' + encodeURIComponent('/admin'));
    return;
  }
  root.appendChild(h('section', { class: 'page-header' }, h('div', null, h('h1', null, '🛠 Administración Bingo Hit'), h('p', { class: 'muted' }, server)), h('div', { class: 'actions' }, button('Inicio', () => navigate('/'), 'btn btn-link'))));
  const tabs = h('div', { class: 'actions' });
  const body = h('div');
  root.appendChild(tabs);
  root.appendChild(body);
  const sections: [string, () => Promise<HTMLElement>][] = [
    ['📊 Métricas', renderStats],
    ['🎤 Animadores', renderHosts],
    ['📅 Eventos', renderEvents],
    ['💳 Pagos', renderOrders],
    ['⚙️ Configuración', renderSettings],
    ['🎁 Promociones y cortesías', renderPromos],
  ];
  const show = async (i: number) => {
    clear(body);
    body.appendChild(h('p', { class: 'muted' }, 'Cargando…'));
    try {
      const el = await (sections[i] as [string, () => Promise<HTMLElement>])[1]();
      clear(body);
      body.appendChild(el);
    } catch (err) {
      clear(body);
      body.appendChild(h('p', { class: 'alert alert-error' }, errorMessage(err)));
      if (String(errorMessage(err)).includes('autorizado')) {
        tokens.setAdmin('');
        navigate('/login?next=' + encodeURIComponent('/admin'));
      }
    }
  };
  sections.forEach(([label], i) => tabs.appendChild(button(label, () => void show(i), 'btn btn-sm')));
  tabs.appendChild(button('Salir', () => void logout(), 'btn btn-sm btn-link'));
  await show(0);
}


function kv(label: string, value: string | number): HTMLElement {
  return h('div', { class: 'stat' }, h('strong', null, String(value)), ' ', h('span', { class: 'small muted' }, label));
}

async function renderStats(): Promise<HTMLElement> {
  const s = await adminApi.stats();
  const cur = 'CLP';
  const n = (k: string) => Number(s[k] ?? 0);
  const el = h(
    'section',
    { class: 'panel' },
    h('h2', null, 'Plataforma'),
    h('div', { class: 'row dj-counts' }, kv('eventos', n('totalEvents')), kv('activos', n('activeEvents')), kv('en directo', n('liveEvents')), kv('animadores', n('hosts')), kv('jugadores', n('players')), kv('conectados ahora', n('concurrentPlayers'))),
    h('div', { class: 'row dj-counts' }, kv('tarjetas gratis', n('cardsFree')), kv('tarjetas pagadas', n('cardsPaid')), kv('ventas confirmadas', formatMoney(n('grossSales'), cur)), kv('ingreso plataforma', formatMoney(n('platformRevenue'), cur)), kv('pagos pendientes', n('ordersPending')), kv('pagos fallidos', n('ordersFailed')), kv('reembolsos', formatMoney(n('refunds'), cur))),
    h('h3', null, 'Ventas por evento'),
    table(['Evento', 'Animador', 'Modalidad', 'Tarjetas', 'Estado', 'Gratis', 'Pagadas', 'Ventas', 'Pendientes'], s.perEvent.map((e) => [e.name, s.perHost.find((x) => x.id === e.hostId)?.name ?? e.hostId, e.eventMode, e.cardDistribution, e.status, e.cardsFree, e.cardsPaid, formatMoney(e.grossSales, cur), e.ordersPending])),
    h('h3', null, 'Ventas por animador'),
    table(['Animador', 'Estado', 'Eventos', 'Tarjetas', 'Ventas brutas (cobradas por Bingo Hit)'], s.perHost.map((x) => [x.name, x.status, x.events, x.cardsTotal, formatMoney(x.grossSales, cur)])),
    h('p', { class: 'small muted' }, 'Las ventas las cobra la plataforma. Cualquier liquidación a animadores es un proceso independiente.'),
  );
  return el;
}

function table(headers: string[], rows: (string | number)[][]): HTMLElement {
  const t = h('table', { class: 'table' });
  t.appendChild(h('thead', null, h('tr', null, ...headers.map((x) => h('th', null, x)))));
  const tb = h('tbody');
  if (!rows.length) tb.appendChild(h('tr', null, h('td', { colSpan: headers.length, class: 'muted' }, 'Sin datos')));
  for (const r of rows) tb.appendChild(h('tr', null, ...r.map((c) => h('td', null, String(c)))));
  t.appendChild(tb);
  return h('div', { class: 'table-wrap' }, t);
}

async function renderHosts(): Promise<HTMLElement> {
  const hosts = await adminApi.hosts();
  const el = h('section', { class: 'panel' }, h('h2', null, 'Animadores'));
  const name = h('input', { class: 'input', type: 'text', placeholder: 'Nombre', required: true });
  const email = h('input', { class: 'input', type: 'email', placeholder: 'Email' });
  const username = h('input', { class: 'input', type: 'text', placeholder: 'Usuario (para iniciar sesión)', autocomplete: 'off', autocapitalize: 'none', required: true, minLength: 3 });
  const password = h('input', { class: 'input', type: 'password', placeholder: 'Contraseña (mín. 6)', autocomplete: 'new-password', required: true, minLength: 6 });
  const create = h('form', { class: 'row' }, name, email, username, password, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Crear animador'));
  const tokenBox = h('p', { class: 'alert alert-warn small' });
  tokenBox.hidden = true;
  create.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await adminApi.createHost({ name: name.value.trim(), email: email.value.trim(), username: username.value.trim(), password: password.value });
      tokenBox.hidden = false;
      tokenBox.replaceChildren(`Animador creado. Entra en "Iniciar" con el usuario ${username.value.trim().toLowerCase()} y su contraseña. Token de API (se muestra una sola vez): `, h('code', null, r.token));
      create.reset();
      el.appendChild(hostRow(await adminApi.hosts().then((hs) => hs.find((x) => x.id === r.user.id)!)));
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });
  el.appendChild(create);
  el.appendChild(tokenBox);
  for (const hst of hosts) el.appendChild(hostRow(hst));
  return el;
}

function hostRow(hst: { id: string; name: string; email: string; username?: string; status: string; permissions: Record<string, boolean | number> }): HTMLElement {
  const perms = h('div', { class: 'perm-grid' });
  const checks: Record<string, HTMLInputElement> = {};
  for (const [key, label] of PERMS) {
    checks[key] = h('input', { type: 'checkbox', checked: !!hst.permissions[key] });
    perms.appendChild(h('label', { class: 'field-check small' }, checks[key], ` ${label}`));
  }
  const cap = h('input', { class: 'input', type: 'number', min: '1', value: String(hst.permissions.maxEventCapacity ?? 500) });
  perms.appendChild(h('label', { class: 'field small' }, 'Aforo máx.', cap));
  const statusBadge = h('span', { class: `badge ${hst.status === 'ACTIVE' ? 'badge-ok' : 'badge-warn'}` }, hst.status === 'ACTIVE' ? 'activo' : 'suspendido');
  const row = h('div', { class: 'event-card' }, h('div', { class: 'row space' }, h('h3', null, `${hst.name} `, h('span', { class: 'small muted' }, `usuario: ${hst.username ?? '—'}${hst.email ? ` · ${hst.email}` : ''}`)), statusBadge), perms);
  const save = button('Guardar permisos', async () => {
    const permissions: Record<string, boolean | number> = {};
    for (const key of Object.keys(checks)) permissions[key] = (checks[key] as HTMLInputElement).checked;
    permissions.maxEventCapacity = Number(cap.value) || 500;
    try {
      await adminApi.updateHost(hst.id, { permissions });
      toast('Permisos guardados', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }, 'btn btn-sm btn-primary');
  const toggle = button(hst.status === 'ACTIVE' ? 'Suspender' : 'Habilitar', async () => {
    try {
      hst.status = hst.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
      await adminApi.updateHost(hst.id, { status: hst.status });
      statusBadge.textContent = hst.status === 'ACTIVE' ? 'activo' : 'suspendido';
      statusBadge.className = `badge ${hst.status === 'ACTIVE' ? 'badge-ok' : 'badge-warn'}`;
      toggle.textContent = hst.status === 'ACTIVE' ? 'Suspender' : 'Habilitar';
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }, 'btn btn-sm');
  const rotate = button('Nuevo token', async () => {
    try {
      const r = await adminApi.rotateToken(hst.id);
      row.appendChild(h('p', { class: 'alert alert-warn small' }, 'Nuevo token (una sola vez): ', h('code', null, r.token)));
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }, 'btn btn-sm');
  const resetPassword = button('Nueva contraseña', async () => {
    const pwd = prompt(`Nueva contraseña para ${hst.name} (mínimo 6 caracteres):`);
    if (!pwd) return;
    try {
      await adminApi.updateHost(hst.id, { password: pwd });
      toast('Contraseña actualizada', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }, 'btn btn-sm');
  row.appendChild(h('div', { class: 'actions' }, save, toggle, resetPassword, rotate));
  return row;
}

async function renderEvents(): Promise<HTMLElement> {
  const events = await adminApi.events();
  const el = h('section', { class: 'panel' }, h('h2', null, 'Todos los eventos'));
  for (const e of events) {
    const s = e.stats;
    const row = h('div', { class: 'event-card' }, h('div', { class: 'row space' }, h('h3', null, e.name), h('span', { class: 'badge badge-warn' }, e.status)), h('p', { class: 'small muted' }, `${e.id} · ${e.eventMode} · ${e.cardDistribution} · animador ${e.hostId}`), s ? h('p', { class: 'small' }, `Tarjetas ${s.cardsTotal} (gratis ${s.cardsFree}, pagadas ${s.cardsPaid}) · ventas ${formatMoney(s.grossSales, e.paid.currency)} · pendientes ${s.ordersPending} · fallidos ${s.ordersFailed} · reembolsos ${formatMoney(s.refunds, e.paid.currency)}`) : null);
    const actions = h('div', { class: 'actions' });
    if (e.status !== 'SUSPENDED') actions.appendChild(button('Suspender', () => void adminApi.setEventStatus(e.id, 'SUSPENDED').then(() => { toast('Evento suspendido', 'success'); row.querySelector('.badge')!.textContent = 'SUSPENDED'; }, (err) => toast(errorMessage(err), 'error')), 'btn btn-sm btn-danger'));
    else actions.appendChild(button('Reactivar (publicado)', () => void adminApi.setEventStatus(e.id, 'PUBLISHED').then(() => { row.querySelector('.badge')!.textContent = 'PUBLISHED'; }, (err) => toast(errorMessage(err), 'error')), 'btn btn-sm'));
    actions.appendChild(h('a', { class: 'btn btn-sm', href: `#/event?e=${encodeURIComponent(e.id)}`, target: '_blank' }, 'Ver landing'));
    row.appendChild(actions);
    el.appendChild(row);
  }
  if (!events.length) el.appendChild(h('p', { class: 'muted' }, 'Sin eventos.'));
  return el;
}

async function renderOrders(): Promise<HTMLElement> {
  const orders = await adminApi.orders();
  const el = h('section', { class: 'panel' }, h('h2', null, 'Órdenes y pagos'));
  const rows = orders.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((o) => {
    const refund = o.status === 'PAID' ? button('Reembolsar', () => void adminApi.refund(o.id).then(() => toast('Reembolsada', 'success'), (err) => toast(errorMessage(err), 'error')), 'btn btn-sm') : null;
    return h('tr', null, h('td', null, o.id), h('td', null, o.eventId), h('td', null, o.playerId), h('td', null, String(o.quantity)), h('td', null, formatMoney(o.total, o.currency)), h('td', null, o.status), h('td', null, new Date(o.createdAt).toLocaleString()), h('td', null, refund));
  });
  const t = h('table', { class: 'table' }, h('thead', null, h('tr', null, ...['Orden', 'Evento', 'Jugador', 'Cant.', 'Total', 'Estado', 'Fecha', ''].map((x) => h('th', null, x)))), h('tbody', null, ...rows));
  el.appendChild(h('div', { class: 'table-wrap' }, rows.length ? t : h('p', { class: 'muted' }, 'Sin órdenes.')));
  return el;
}

async function renderSettings(): Promise<HTMLElement> {
  const s = await adminApi.settings();
  const provider = h('select', { class: 'input' }, ...['mock', 'transbank', 'mercadopago'].map((v) => h('option', { value: v, selected: v === s.payments.provider }, v === 'mock' ? 'Proveedor de pruebas (mock)' : v === 'transbank' ? 'Transbank Webpay Plus' : 'Mercado Pago')));
  const tbkCode = h('input', { class: 'input', type: 'text', value: s.payments.providers.transbank.commerceCode ?? '', placeholder: 'Código de comercio' });
  const tbkKey = h('input', { class: 'input', type: 'password', placeholder: s.payments.providers.transbank.apiKey ? 'API key guardada (••••)' : 'API key', autocomplete: 'off' });
  const tbkEnv = h('select', { class: 'input' }, h('option', { value: 'integration', selected: s.payments.providers.transbank.environment !== 'production' }, 'Integración'), h('option', { value: 'production', selected: s.payments.providers.transbank.environment === 'production' }, 'Producción'));
  const mpToken = h('input', { class: 'input', type: 'password', placeholder: s.payments.providers.mercadopago.accessToken ? 'Access token guardado (••••)' : 'Access token', autocomplete: 'off' });
  const hostCanSet = h('input', { type: 'checkbox', checked: !!s.pricing.hostCanSetPrice });
  const fixed = h('input', { class: 'input', type: 'number', value: String(s.pricing.fixedCardPrice) });
  const min = h('input', { class: 'input', type: 'number', value: String(s.pricing.minimumCardPrice) });
  const max = h('input', { class: 'input', type: 'number', value: String(s.pricing.maximumCardPrice) });
  const currency = h('input', { class: 'input', type: 'text', value: s.pricing.defaultCurrency, maxLength: 3 });
  const maxCap = h('input', { class: 'input', type: 'number', value: String(s.limits.maxEventCapacity) });
  const maxCards = h('input', { class: 'input', type: 'number', value: String(s.limits.maxCardsPerPlayer) });
  const fee = h('input', { class: 'input', type: 'number', value: String(s.commission.platformFeePct), min: '0', max: '100' });
  const form = h(
    'form',
    { class: 'panel' },
    h('h2', null, 'Pagos de la plataforma'),
    h('p', { class: 'small muted' }, 'Todos los pagos los recibe Bingo Hit. Las credenciales se guardan en el servidor y nunca se devuelven en claro.'),
    h('div', { class: 'fields' }, h('label', { class: 'field' }, 'Proveedor activo', provider), h('label', { class: 'field' }, 'Transbank · código de comercio', tbkCode), h('label', { class: 'field' }, 'Transbank · API key', tbkKey), h('label', { class: 'field' }, 'Transbank · ambiente', tbkEnv), h('label', { class: 'field' }, 'Mercado Pago · access token', mpToken)),
    h('h2', null, 'Política de precios'),
    h('div', { class: 'fields' }, h('label', { class: 'field field-check' }, hostCanSet, ' Los animadores con permiso pueden fijar el precio'), h('label', { class: 'field' }, 'Precio fijo por tarjeta', fixed), h('label', { class: 'field' }, 'Precio mínimo (0 = sin límite)', min), h('label', { class: 'field' }, 'Precio máximo (0 = sin límite)', max), h('label', { class: 'field' }, 'Moneda', currency), h('label', { class: 'field' }, 'Comisión de plataforma (%)', fee)),
    h('h2', null, 'Límites globales'),
    h('div', { class: 'fields' }, h('label', { class: 'field' }, 'Aforo máximo por evento', maxCap), h('label', { class: 'field' }, 'Máximo de tarjetas por jugador', maxCards)),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Guardar configuración'),
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await adminApi.saveSettings({
        payments: { provider: provider.value, providers: { transbank: { commerceCode: tbkCode.value, ...(tbkKey.value ? { apiKey: tbkKey.value } : {}), environment: tbkEnv.value }, mercadopago: mpToken.value ? { accessToken: mpToken.value } : {} } },
        pricing: { hostCanSetPrice: hostCanSet.checked, fixedCardPrice: Number(fixed.value), minimumCardPrice: Number(min.value), maximumCardPrice: Number(max.value), defaultCurrency: currency.value },
        limits: { maxEventCapacity: Number(maxCap.value), maxCardsPerPlayer: Number(maxCards.value) },
        commission: { platformFeePct: Number(fee.value) },
      });
      toast('Configuración guardada', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });
  return form;
}

async function renderPromos(): Promise<HTMLElement> {
  const promos = await adminApi.promotions();
  const el = h('section', { class: 'panel' }, h('h2', null, 'Promociones'));
  const code = h('input', { class: 'input', type: 'text', placeholder: 'CÓDIGO', required: true });
  const type = h('select', { class: 'input' }, h('option', { value: 'FREE_CARDS' }, 'Tarjetas gratis'), h('option', { value: 'DISCOUNT_PCT' }, 'Descuento %'));
  const value = h('input', { class: 'input', type: 'number', value: '1', min: '1' });
  const maxUses = h('input', { class: 'input', type: 'number', value: '0', min: '0', placeholder: 'Usos máx. (0 = ilimitado)' });
  const eventId = h('input', { class: 'input', type: 'text', placeholder: 'ID de evento (vacío = todos)' });
  const form = h('form', { class: 'fields' }, h('label', { class: 'field' }, 'Código', code), h('label', { class: 'field' }, 'Tipo', type), h('label', { class: 'field' }, 'Valor (tarjetas o %)', value), h('label', { class: 'field' }, 'Usos máximos', maxUses), h('label', { class: 'field' }, 'Evento', eventId), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Crear promoción'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await adminApi.createPromotion({ code: code.value, type: type.value, value: Number(value.value), maxUses: Number(maxUses.value), eventId: eventId.value.trim() || null });
      toast('Promoción creada', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });
  el.appendChild(form);
  el.appendChild(table(['Código', 'Tipo', 'Valor', 'Usos', 'Evento', 'Activa'], promos.map((p) => [p.code, p.type, p.value, `${p.uses}/${p.maxUses || '∞'}`, p.eventId ?? 'todos', p.active ? 'sí' : 'no'])));
  el.appendChild(h('h2', null, 'Tarjetas de cortesía'));
  const cEvent = h('input', { class: 'input', type: 'text', placeholder: 'ID de evento', required: true });
  const cPlayer = h('input', { class: 'input', type: 'text', placeholder: 'ID de jugador', required: true });
  const cQty = h('input', { class: 'input', type: 'number', value: '1', min: '1' });
  const cType = h('select', { class: 'input' }, h('option', { value: 'COMPLIMENTARY' }, 'Cortesía'), h('option', { value: 'PROMO' }, 'Promoción'), h('option', { value: 'LOCAL' }, 'Presencial'));
  const cForm = h('form', { class: 'fields' }, h('label', { class: 'field' }, 'Evento', cEvent), h('label', { class: 'field' }, 'Jugador', cPlayer), h('label', { class: 'field' }, 'Cantidad', cQty), h('label', { class: 'field' }, 'Tipo', cType), h('button', { class: 'btn', type: 'submit' }, 'Entregar tarjetas'));
  cForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await adminApi.complimentary({ eventId: cEvent.value.trim(), playerId: cPlayer.value.trim(), quantity: Number(cQty.value), acquisitionType: cType.value });
      toast(`${r.cards.length} tarjeta(s) entregadas`, 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });
  el.appendChild(cForm);
  const players = await adminApi.players();
  el.appendChild(h('details', null, h('summary', null, `Jugadores (${players.length})`), table(['ID', 'Nombre', 'Contacto'], players.map((p) => [p.id, p.name, p.contact]))));
  return el;
}
