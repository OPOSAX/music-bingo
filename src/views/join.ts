/** Unirse a la partida con el QR único: el jugador escribe su nombre y recibe la siguiente tarjeta libre. */

import { generateCard } from '../bingo.js';
import { button, clear, errorMessage, h, toast } from '../dom.js';
import { navigate } from '../router.js';
import { decodeJoinPayload, type JoinPayload, type SharedCard } from '../share.js';
import { loadAssignment, playerId, saveAssignment } from '../store.js';
import { assemblePool, nextFreeIndex, publishMessage, subscribeTopic, type PoolMessage, type SyncState } from '../sync.js';
import { renderCardView } from './card.js';

const NAME_KEY = 'musicbingo:playerName';

export async function renderJoin(root: HTMLElement, params: URLSearchParams): Promise<void> {
  clear(root);
  const payload = params.get('d');
  if (!payload) {
    root.appendChild(h('section', { class: 'panel' }, h('p', { class: 'alert alert-error' }, 'Falta la partida en el enlace.'), button('Inicio', () => navigate('/'), 'btn')));
    return;
  }
  let join: JoinPayload;
  try {
    join = await decodeJoinPayload(payload);
  } catch (err) {
    root.appendChild(h('section', { class: 'panel' }, h('p', { class: 'alert alert-error' }, errorMessage(err)), button('Inicio', () => navigate('/'), 'btn')));
    return;
  }

  const existing = loadAssignment(join.g);
  if (existing) {
    await connectAndShow(root, join, existing.name, existing.index);
    return;
  }

  const input = h('input', { class: 'input', type: 'text', placeholder: 'Tu nombre', maxLength: 40, autocomplete: 'name', value: localStorage.getItem(NAME_KEY) ?? '' });
  const form = h(
    'form',
    { class: 'panel' },
    h('h1', null, '🎵 Bingo musical'),
    h('p', { class: 'muted' }, `Partida ${join.g} · ${join.t}`),
    h('h2', null, '¿Cuál es tu nombre?'),
    h('div', { class: 'row' }, input, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Entrar')),
    h('p', { class: 'muted small' }, 'Recibirás una tarjeta; las canciones que suenen se marcarán solas.'),
  );
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = input.value.trim();
    if (!name) {
      toast('Escribe tu nombre.', 'error');
      return;
    }
    localStorage.setItem(NAME_KEY, name);
    void connectAndShow(root, join, name, null);
  });
  root.appendChild(form);
  input.focus();
}

/** Se conecta al canal, pide una tarjeta si hace falta y muestra la tarjeta. */
async function connectAndShow(root: HTMLElement, join: JoinPayload, name: string, assignedIndex: number | null): Promise<void> {
  clear(root);
  const status = h('p', { class: 'muted' }, 'Conectando con el anfitrión…');
  const panel = h('section', { class: 'panel center' }, h('h1', null, `Hola, ${name}`), status);
  root.appendChild(panel);

  const cid = playerId();
  const chunks = new Map<number, PoolMessage>();
  let pool: [string, string][] | null = null;
  let latestState: SyncState | null = null;
  let requested: number | null = assignedIndex;
  let attempts = 0;
  let confirmed: number | null = assignedIndex;
  let done = false;
  let firstStateTimer: number | null = null;

  const finish = () => {
    if (done || confirmed === null || !pool) return;
    done = true;
    subscription.close();
    saveAssignment(join.g, { index: confirmed, name });
    const card = generateCard({ seed: join.g, gridSize: join.s, freeCenter: join.f, cardCount: join.n, snippetSeconds: 20, startMode: 'random' }, join.p, confirmed);
    const shared: SharedCard = {
      v: 1,
      g: join.g,
      n: confirmed,
      s: join.s,
      t: join.t,
      c: card.cells.map((c) => (c === null ? null : (pool as [string, string][])[c] ?? ['?', ''])),
      i: card.cells,
      y: join.y,
    };
    renderCardView(root, shared, name);
    toast(`Tarjeta ${confirmed + 1} asignada a ${name}`, 'success');
  };

  const claim = async (index: number) => {
    requested = index;
    attempts++;
    status.textContent = `Pidiendo la tarjeta ${index + 1}…`;
    const ok = await publishMessage(join.y, { k: 'claim', seed: join.g, index, name, cid, t: Date.now() });
    if (!ok) status.textContent = 'No se pudo enviar la petición. Comprueba la conexión y recarga.';
  };

  const evaluate = () => {
    if (done) return;
    if (confirmed === null && latestState) {
      const claims = latestState.claims ?? {};
      if (requested !== null) {
        const mine = claims[String(requested)];
        if (mine?.c === cid) confirmed = requested;
        else if (mine && mine.c !== cid) {
          const next = nextFreeIndex(claims, join.n, cid, requested);
          if (next === null || attempts > join.n) {
            status.textContent = 'No quedan tarjetas libres. Pide al anfitrión que cree más tarjetas.';
            return;
          }
          void claim(next);
          return;
        }
      } else {
        // Quizá el anfitrión ya nos asignó una (p. ej. tras recargar sin datos guardados).
        const already = Object.entries(claims).find(([, v]) => v.c === cid);
        if (already) confirmed = Number(already[0]);
        else {
          const next = nextFreeIndex(claims, join.n, cid);
          if (next === null) {
            status.textContent = 'No quedan tarjetas libres. Pide al anfitrión que cree más tarjetas.';
            return;
          }
          void claim(next);
          return;
        }
      }
    }
    if (confirmed !== null && !pool) status.textContent = `Tarjeta ${confirmed + 1} asignada. Recibiendo las canciones…`;
    finish();
  };

  const subscription = subscribeTopic(
    join.y,
    (msg) => {
      if (msg.k === 'pool' && msg.seed === join.g) {
        chunks.set(msg.i, msg);
        pool = assemblePool(chunks, join.p);
        evaluate();
      } else if (msg.k === 'state' && msg.state.seed === join.g) {
        latestState = msg.state;
        if (firstStateTimer !== null) {
          window.clearTimeout(firstStateTimer);
          firstStateTimer = null;
        }
        evaluate();
      }
    },
    (online) => {
      if (!online && !done) status.textContent = 'Sin conexión con el anfitrión. Reintentando…';
    },
  );

  // Si el anfitrión aún no ha publicado nada, pedimos la primera tarjeta igualmente.
  if (assignedIndex === null) {
    firstStateTimer = window.setTimeout(() => {
      firstStateTimer = null;
      if (!latestState && requested === null) void claim(0);
    }, 4000);
  }
  window.setTimeout(() => {
    if (!done && confirmed === null) status.textContent = 'El anfitrión no responde. Asegúrate de que tiene la partida abierta en su pantalla y vuelve a intentarlo.';
  }, 25000);
}
