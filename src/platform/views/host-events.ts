/** Panel del animador (#/events): sus eventos, asistente de creación (modalidad y tarjetas desacopladas) y estadísticas. */

import { button, clear, errorMessage, h, toast } from '../../dom.js';
import { navigate } from '../../router.js';
import { loadGame } from '../../store.js';
import { formatMoney, formatWhen, hostApi, resolveServer, tokens, type CardDistribution, type EventMode, type HostEvent } from '../api.js';

const MODE_LABEL: Record<EventMode, string> = { LOCAL: 'Presencial', ONLINE: 'Online', HYBRID: 'Híbrido' };
const DIST_LABEL: Record<CardDistribution, string> = { FREE: 'Gratis', PAID: 'Pagadas' };
const STATUS_LABEL: Record<string, string> = { DRAFT: 'Borrador', PUBLISHED: 'Publicado', LIVE: 'En curso', FINISHED: 'Terminado', SUSPENDED: 'Suspendido' };

export async function renderHostEvents(root: HTMLElement, params: URLSearchParams): Promise<void> {
  clear(root);
  const server = await resolveServer(params.get('l'));
  root.appendChild(h('section', { class: 'page-header' }, h('div', null, h('h1', null, '🎤 Mis eventos Bingo Hit'), h('p', { class: 'muted' }, server ? `Plataforma: ${server}` : 'Sin servidor')), h('div', { class: 'actions' }, button('Partida (Spotify)', () => navigate('/host'), 'btn'), button('Inicio', () => navigate('/'), 'btn btn-link'))));
  if (!server || !tokens.host()) {
    root.appendChild(renderLogin(root, params, server));
    return;
  }
  let me: Awaited<ReturnType<typeof hostApi.me>>;
  try {
    me = await hostApi.me();
  } catch (err) {
    tokens.setHost('');
    root.appendChild(h('p', { class: 'alert alert-error' }, `No se pudo iniciar sesión: ${errorMessage(err)}`));
    root.appendChild(renderLogin(root, params, server));
    return;
  }
  const list = h('section', { class: 'panel' }, h('h2', null, 'Eventos'));
  const wizardHost = h('div');
  root.appendChild(h('section', { class: 'panel' }, h('p', null, `Hola, ${me.name}. `, h('span', { class: 'small muted' }, permissionsSummary(me.permissions))), h('div', { class: 'actions' }, button('➕ Nuevo evento', () => { clear(wizardHost); wizardHost.appendChild(renderWizard(me, null, refresh)); wizardHost.scrollIntoView({ behavior: 'smooth' }); }, 'btn btn-primary'), button('Cerrar sesión', () => { tokens.setHost(''); void renderHostEvents(root, params); }, 'btn btn-link'))));
  root.appendChild(wizardHost);
  root.appendChild(list);
  async function refresh(): Promise<void> {
    clear(list);
    list.appendChild(h('h2', null, 'Eventos'));
    try {
      const events = await hostApi.events();
      if (!events.length) list.appendChild(h('p', { class: 'muted' }, 'Todavía no tienes eventos. Crea el primero con "Nuevo evento".'));
      for (const e of events.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) list.appendChild(renderEventCard(e, me, refresh, wizardHost));
    } catch (err) {
      list.appendChild(h('p', { class: 'alert alert-error' }, errorMessage(err)));
    }
  }
  await refresh();
}

function permissionsSummary(p: Record<string, boolean | number>): string {
  const modes = [p.canCreateLocalEvents && 'presencial', p.canCreateOnlineEvents && 'online', p.canCreateHybridEvents && 'híbrido'].filter(Boolean).join(', ');
  const dist = [p.canCreateFreeEvents && 'gratis', p.canCreatePaidEvents && 'pagadas'].filter(Boolean).join(', ');
  return `Puedes crear eventos ${modes || '(ninguno)'} con tarjetas ${dist || '(ninguna)'}${p.canStartLive ? ' y transmitir en directo' : ''}. Aforo máximo ${p.maxEventCapacity}.`;
}

function renderLogin(root: HTMLElement, params: URLSearchParams, server: string): HTMLElement {
  const url = h('input', { class: 'input', type: 'url', value: server, placeholder: 'https://servidor-bingo-hit' });
  const tok = h('input', { class: 'input', type: 'password', placeholder: 'Token de animador (te lo da el administrador)', autocomplete: 'off' });
  const form = h('form', { class: 'panel' }, h('h2', null, 'Acceso de animador'), h('div', { class: 'fields' }, h('label', { class: 'field' }, 'Servidor', url), h('label', { class: 'field' }, 'Token', tok)), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Entrar'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    await resolveServer(url.value.trim());
    tokens.setHost(tok.value.trim());
    await renderHostEvents(root, params);
  });
  return form;
}

function renderEventCard(e: HostEvent, me: Awaited<ReturnType<typeof hostApi.me>>, refresh: () => Promise<void>, wizardHost: HTMLElement): HTMLElement {
  const s = e.stats;
  const link = `${location.origin}${location.pathname.replace(/index\.html$/, '')}#/event?e=${encodeURIComponent(e.id)}`;
  const act = (label: string, fn: () => Promise<unknown>, cls = 'btn btn-sm') => button(label, () => void fn().then(refresh, (err) => toast(errorMessage(err), 'error')), cls);
  const actions = h('div', { class: 'actions' });
  if (e.status === 'DRAFT') actions.appendChild(act('Publicar', () => hostApi.publish(e.id), 'btn btn-sm btn-primary'));
  if (e.status === 'PUBLISHED') actions.appendChild(act('▶ Empezar evento', () => hostApi.start(e.id), 'btn btn-sm btn-primary'));
  if (e.status === 'LIVE') actions.appendChild(act('■ Terminar', () => hostApi.finish(e.id), 'btn btn-sm btn-danger'));
  if (['DRAFT', 'PUBLISHED', 'LIVE'].includes(e.status)) actions.appendChild(button('Editar', () => { clear(wizardHost); wizardHost.appendChild(renderWizard(me, e, refresh)); wizardHost.scrollIntoView({ behavior: 'smooth' }); }, 'btn btn-sm'));
  if (e.eventMode !== 'LOCAL' && ['PUBLISHED', 'LIVE'].includes(e.status)) actions.appendChild(button('🎥 Transmitir', () => navigate(`/live?event=${encodeURIComponent(e.id)}&l=${encodeURIComponent(location.origin)}&token=${encodeURIComponent(tokens.host())}`), 'btn btn-sm'));
  actions.appendChild(button('🎵 Conducir bingo', () => navigate(`/host?event=${encodeURIComponent(e.id)}`), 'btn btn-sm'));
  const card = h(
    'div',
    { class: `event-card status-${e.status.toLowerCase()}` },
    h('div', { class: 'row space' }, h('h3', null, e.name), h('span', { class: `badge ${e.status === 'LIVE' ? 'badge-live' : e.status === 'PUBLISHED' ? 'badge-ok' : 'badge-warn'}` }, STATUS_LABEL[e.status] ?? e.status)),
    h('p', { class: 'small muted' }, `${MODE_LABEL[e.eventMode]} · tarjetas ${DIST_LABEL[e.cardDistribution].toLowerCase()}${e.cardDistribution === 'PAID' ? ` (${formatMoney(e.paid.pricePerCard, e.paid.currency)})` : ''} · ${formatWhen(e.startsAt)} · ${e.game.tracks.length} canciones · aforo ${e.capacity}`),
    s
      ? h(
          'div',
          { class: 'row dj-counts' },
          stat('🎟 entregadas', s.cardsTotal),
          stat('🆓 gratis', s.cardsFree),
          stat('💳 pagadas', s.cardsPaid),
          stat('💰 ventas', formatMoney(s.grossSales, e.paid.currency)),
          stat('🛒 pendientes', s.ordersPending),
          stat('👥 jugadores', s.uniquePlayers),
        )
      : null,
    h('p', { class: 'small' }, h('a', { href: link, target: '_blank' }, link)),
    actions,
  );
  return card;
}

function stat(label: string, value: number | string): HTMLElement {
  return h('div', { class: 'stat' }, h('strong', null, String(value)), ' ', h('span', { class: 'small muted' }, label));
}

function input(type: string, value: string | number | null | undefined, extra: Record<string, unknown> = {}): HTMLInputElement {
  return h('input', { class: 'input', type, value: value === null || value === undefined ? '' : String(value), ...extra });
}

function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v: string): string | null {
  return v ? new Date(v).toISOString() : null;
}

/** Asistente de creación/edición: información general, modalidad, tarjetas y opciones según FREE/PAID. */
function renderWizard(me: Awaited<ReturnType<typeof hostApi.me>>, existing: HostEvent | null, onDone: () => Promise<void>): HTMLElement {
  const p = me.permissions;
  const game = loadGame();
  const f = {
    name: input('text', existing?.name ?? game?.playlistName ?? '', { placeholder: 'Nombre del evento', maxLength: 120, required: true }),
    description: h('textarea', { class: 'input', rows: 3, placeholder: 'Descripción' }),
    startsAt: input('datetime-local', toLocalInput(existing?.startsAt)),
    coverUrl: input('url', existing?.coverUrl ?? '', { placeholder: 'https://… (imagen de portada)' }),
    prizes: input('text', existing?.prizes ?? '', { placeholder: 'Premios' }),
    rules: h('textarea', { class: 'input', rows: 2, placeholder: 'Reglas' }),
    capacity: input('number', existing?.capacity ?? 200, { min: '1', max: String(p.maxEventCapacity) }),
    freeMax: input('number', existing?.free.maxCardsPerPlayer ?? 1, { min: '1' }),
    freeTotal: input('number', existing?.free.totalCardLimit ?? 0, { min: '0' }),
    freeOpens: input('datetime-local', toLocalInput(existing?.free.opensAt)),
    freeCloses: input('datetime-local', toLocalInput(existing?.free.closesAt)),
    freeGuests: h('input', { type: 'checkbox', checked: existing?.free.allowGuests !== false }),
    freePromo: h('input', { type: 'checkbox', checked: existing?.free.allowPromoCodes !== false }),
    price: input('number', existing?.paid.pricePerCard ?? me.pricing.fixedCardPrice, { min: String(me.pricing.minimumCardPrice), step: '1', disabled: !me.pricing.hostCanSetPrice }),
    paidMax: input('number', existing?.paid.maxCardsPerPlayer ?? 3, { min: '1' }),
    paidTotal: input('number', existing?.paid.totalCardLimit ?? 0, { min: '0' }),
    salesStart: input('datetime-local', toLocalInput(existing?.paid.salesStartAt)),
    salesEnd: input('datetime-local', toLocalInput(existing?.paid.salesEndAt)),
  };
  f.description.value = existing?.description ?? '';
  f.rules.value = existing?.rules ?? '';
  let eventMode: EventMode = existing?.eventMode ?? (p.canCreateLocalEvents ? 'LOCAL' : 'ONLINE');
  let dist: CardDistribution = existing?.cardDistribution ?? (p.canCreateFreeEvents ? 'FREE' : 'PAID');
  const radios = <T extends string>(name: string, options: [T, string, boolean][], current: T, onChange: (v: T) => void) =>
    h(
      'div',
      { class: 'radio-row' },
      ...options.map(([value, label, allowed]) => {
        const r = h('input', { type: 'radio', name, value, checked: value === current, disabled: !allowed });
        r.addEventListener('change', () => onChange(value));
        return h('label', { class: `radio ${allowed ? '' : 'muted'}` }, r, ` ${label}${allowed ? '' : ' (sin permiso)'}`);
      }),
    );
  const freeBox = h('div', { class: 'fields' }, h('label', { class: 'field' }, 'Máximo de tarjetas por jugador', f.freeMax), h('label', { class: 'field' }, 'Cantidad total disponible (0 = aforo)', f.freeTotal), h('label', { class: 'field' }, 'Apertura de entrega', f.freeOpens), h('label', { class: 'field' }, 'Cierre de entrega', f.freeCloses), h('label', { class: 'field field-check' }, f.freeGuests, ' Permitir invitados'), h('label', { class: 'field field-check' }, f.freePromo, ' Permitir códigos promocionales'));
  const paidBox = h('div', { class: 'fields' }, h('label', { class: 'field' }, `Precio por tarjeta (${me.pricing.currency})${me.pricing.hostCanSetPrice ? '' : ' · fijado por la plataforma'}`, f.price), h('label', { class: 'field' }, 'Máximo de tarjetas por jugador', f.paidMax), h('label', { class: 'field' }, 'Stock (0 = aforo)', f.paidTotal), h('label', { class: 'field' }, 'Inicio de ventas', f.salesStart), h('label', { class: 'field' }, 'Cierre de ventas', f.salesEnd));
  const syncBoxes = () => {
    freeBox.hidden = dist !== 'FREE';
    paidBox.hidden = dist !== 'PAID';
  };
  syncBoxes();
  const useGame = h('input', { type: 'checkbox', checked: !existing && !!game });
  const status = h('p', { class: 'small muted' });
  const form = h(
    'form',
    { class: 'panel wizard' },
    h('h2', null, existing ? `Editar: ${existing.name}` : 'Nuevo evento'),
    h('h3', null, '1. Información general'),
    h('div', { class: 'fields' }, h('label', { class: 'field' }, 'Nombre', f.name), h('label', { class: 'field' }, 'Fecha y hora', f.startsAt), h('label', { class: 'field' }, 'Imagen / cover (URL)', f.coverUrl), h('label', { class: 'field' }, 'Premios', f.prizes), h('label', { class: 'field' }, 'Aforo (máx. ' + p.maxEventCapacity + ')', f.capacity)),
    h('label', { class: 'field' }, 'Descripción', f.description),
    h('label', { class: 'field' }, 'Reglas', f.rules),
    h('h3', null, '2. Modalidad'),
    radios<EventMode>('mode', [['LOCAL', 'Presencial', !!p.canCreateLocalEvents], ['ONLINE', 'Online', !!p.canCreateOnlineEvents], ['HYBRID', 'Híbrido', !!p.canCreateHybridEvents]], eventMode, (v) => (eventMode = v)),
    h('p', { class: 'small muted' }, 'Presencial: QR en el recinto, sin transmisión obligatoria. Online e híbrido: transmisión en directo del animador.'),
    h('h3', null, '3. Tarjetas musicales'),
    radios<CardDistribution>('dist', [['FREE', 'Gratis', !!p.canCreateFreeEvents], ['PAID', 'Pagadas', !!p.canCreatePaidEvents]], dist, (v) => { dist = v; syncBoxes(); }),
    freeBox,
    paidBox,
    h('h3', null, '4. Canciones'),
    game && !existing ? h('label', { class: 'field field-check' }, useGame, ` Usar la partida actual de Spotify: ${game.playlistName} (${game.tracks.length} canciones, ${game.config.cardCount} tarjetas)`) : h('p', { class: 'small muted' }, existing ? `${existing.game.tracks.length} canciones cargadas. Para cambiarlas, crea la partida en "Partida (Spotify)" y publícala en este evento.` : 'Crea antes una partida en "Partida (Spotify)" para cargar las canciones, o hazlo después desde la pantalla del anfitrión.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, existing ? 'Guardar cambios' : 'Crear evento'), button('Cancelar', () => form.remove(), 'btn btn-link')),
    status,
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body: Record<string, unknown> = {
      name: f.name.value.trim(),
      description: f.description.value.trim(),
      startsAt: fromLocalInput(f.startsAt.value),
      coverUrl: f.coverUrl.value.trim(),
      prizes: f.prizes.value.trim(),
      rules: f.rules.value.trim(),
      capacity: Number(f.capacity.value) || 200,
      eventMode,
      cardDistribution: dist,
      free: { maxCardsPerPlayer: Number(f.freeMax.value) || 1, totalCardLimit: Number(f.freeTotal.value) || 0, opensAt: fromLocalInput(f.freeOpens.value), closesAt: fromLocalInput(f.freeCloses.value), allowGuests: f.freeGuests.checked, allowPromoCodes: f.freePromo.checked },
      paid: { pricePerCard: Number(f.price.value) || 0, maxCardsPerPlayer: Number(f.paidMax.value) || 3, totalCardLimit: Number(f.paidTotal.value) || 0, salesStartAt: fromLocalInput(f.salesStart.value), salesEndAt: fromLocalInput(f.salesEnd.value) },
    };
    if (!existing && game && useGame.checked) {
      body.game = { seed: game.config.seed, gridSize: game.config.gridSize, freeCenter: game.config.freeCenter, cardCount: game.config.cardCount, playlistName: game.playlistName, topic: game.syncTopic ?? '', tracks: game.tracks.map((t) => [t.name, t.artists]) };
    }
    status.textContent = 'Guardando…';
    try {
      const saved = existing ? await hostApi.update(existing.id, body) : await hostApi.create(body);
      toast(existing ? 'Evento actualizado' : `Evento ${saved.id} creado`, 'success');
      form.remove();
      await onDone();
    } catch (err) {
      status.textContent = '';
      toast(errorMessage(err), 'error');
    }
  });
  return form;
}
