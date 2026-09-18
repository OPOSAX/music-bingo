/** Reparto de tarjetas: muestra el QR de cada tarjeta en grande, de una en una, para que cada jugador escanee el suyo. */

import { cardLabel } from '../bingo.js';
import { button, clear, copyText, errorMessage, h, toast } from '../dom.js';
import { encodeText, toSvgElement } from '../qr.js';
import { navigate } from '../router.js';
import type { GameState } from '../store.js';
import { loadGame } from '../store.js';
import { cardShareUrl } from './cards.js';

export async function renderDeal(root: HTMLElement, params: URLSearchParams): Promise<void> {
  clear(root);
  const loaded = loadGame();
  if (!loaded) {
    root.appendChild(h('section', { class: 'panel' }, h('h2', null, 'No hay ninguna partida'), button('Crear partida', () => navigate('/setup'), 'btn btn-primary')));
    return;
  }
  const game: GameState = loaded;
  const total = game.config.cardCount;
  let index = Math.min(total - 1, Math.max(0, Number(params.get('n') ?? '1') - 1 || 0));

  const title = h('h1', null);
  const subtitle = h('p', { class: 'muted' });
  const qrHost = h('div', { class: 'deal-qr' });
  const prevBtn = button('← Anterior', () => show(index - 1), 'btn btn-lg');
  const nextBtn = button('Siguiente tarjeta →', () => show(index + 1), 'btn btn-primary btn-lg');
  const copyBtn = button('Copiar enlace', () => void copyCurrent(), 'btn');
  const jump = h('input', { class: 'input', type: 'number', min: '1', max: String(total), value: String(index + 1) });
  jump.addEventListener('change', () => show(Number(jump.value) - 1));

  root.appendChild(
    h(
      'header',
      { class: 'page-header' },
      h('div', null, title, subtitle),
      h('div', { class: 'actions' }, button('Tarjetas', () => navigate('/cards'), 'btn'), button('← Partida', () => navigate('/host'), 'btn btn-link')),
    ),
  );
  root.appendChild(
    h(
      'section',
      { class: 'panel deal-panel' },
      qrHost,
      h('p', { class: 'deal-hint' }, 'Escanea el QR con la cámara del móvil para abrir tu tarjeta. Cuando la tengas, el anfitrión pasa a la siguiente.'),
      h('div', { class: 'actions center' }, prevBtn, h('label', { class: 'field deal-jump' }, h('span', null, 'Ir a la tarjeta'), jump), nextBtn),
      h('div', { class: 'actions center' }, copyBtn),
    ),
  );

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'ArrowRight' || ev.key === ' ') show(index + 1);
    else if (ev.key === 'ArrowLeft') show(index - 1);
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', () => window.removeEventListener('keydown', onKey), { once: true });

  async function copyCurrent(): Promise<void> {
    try {
      const ok = await copyText(await cardShareUrl(game, index));
      toast(ok ? 'Enlace copiado' : 'No se pudo copiar', ok ? 'success' : 'error');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  function show(i: number): void {
    if (i < 0 || i >= total) return;
    index = i;
    jump.value = String(i + 1);
    history.replaceState(null, '', `#/deal?n=${i + 1}`);
    title.textContent = `Tarjeta ${i + 1} de ${total}`;
    subtitle.textContent = `Código ${cardLabel(game.config.seed, i)} · ${game.playlistName}`;
    prevBtn.disabled = i === 0;
    nextBtn.disabled = i === total - 1;
    clear(qrHost);
    qrHost.appendChild(h('p', { class: 'muted' }, 'Generando QR…'));
    void cardShareUrl(game, i)
      .then((url) => {
        if (index !== i) return;
        clear(qrHost);
        qrHost.appendChild(toSvgElement(encodeText(url, { ecc: 'M' }), { border: 3 }));
      })
      .catch((err) => {
        clear(qrHost);
        qrHost.appendChild(h('p', { class: 'alert alert-error' }, errorMessage(err)));
      });
  }

  show(index);
}
