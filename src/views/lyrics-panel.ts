/** Panel de letra con resaltado de la línea en curso (karaoke). */

import { button, clear, h } from '../dom.js';
import { currentLineIndex, fetchLyrics, lastLyricsError, type Lyrics, type LyricsQuery } from '../lyrics.js';

export interface PlaybackClock {
  /** Momento (ms, Date.now()) en que empezó a sonar el fragmento. */
  at: number;
  /** Posición de la canción en ese momento (ms). */
  pos: number;
  /** Duración del fragmento (ms). */
  len: number;
}

export interface LyricsPanel {
  el: HTMLElement;
  /** Muestra la letra de una canción (null para vaciar). */
  show(track: LyricsQuery | null, clock: PlaybackClock | null): void;
  setClock(clock: PlaybackClock | null): void;
  destroy(): void;
}

export function createLyricsPanel(options: { compact?: boolean } = {}): LyricsPanel {
  const body = h('div', { class: 'lyrics-body' });
  const status = h('p', { class: 'muted small' });
  const el = h('section', { class: `lyrics${options.compact ? ' compact' : ''}` }, h('div', { class: 'row space' }, h('h3', null, '🎤 Letra'), status), body);
  let current: LyricsQuery | null = null;
  let lyrics: Lyrics | null = null;
  let clock: PlaybackClock | null = null;
  let timer: number | null = null;
  let lineEls: HTMLElement[] = [];
  let lastIndex = -2;
  // Seguimiento automático: la línea actual se mantiene centrada. Si la persona desplaza la letra a mano
  // (rueda, dedo), se respeta durante unos segundos y luego se retoma el seguimiento.
  let userScrolledAt = 0;
  const markUserScroll = () => { userScrolledAt = Date.now(); };
  body.addEventListener('wheel', markUserScroll, { passive: true });
  body.addEventListener('touchmove', markUserScroll, { passive: true });

  function stopTimer(): void {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  }

  function positionNow(): number | null {
    if (!clock) return null;
    const elapsed = Date.now() - clock.at;
    if (elapsed < -2000) return null;
    return clock.pos + Math.min(Math.max(0, elapsed), clock.len);
  }

  function tick(): void {
    if (!lyrics || lyrics.synced.length === 0) return;
    const pos = positionNow();
    const index = pos === null ? -1 : currentLineIndex(lyrics.synced, pos);
    if (index === lastIndex) return;
    lastIndex = index;
    lineEls.forEach((line, i) => {
      line.classList.toggle('current', i === index);
      line.classList.toggle('past', i < index);
    });
    const target = lineEls[index];
    if (target && Date.now() - userScrolledAt > 6000) centerLine(target);
  }

  /** Desplaza solo el cuadro de la letra (no la página) para dejar la línea en el centro. */
  function centerLine(target: HTMLElement): void {
    const top = target.offsetTop - (body.clientHeight - target.offsetHeight) / 2;
    body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  function render(): void {
    clear(body);
    lineEls = [];
    userScrolledAt = 0;
    body.scrollTop = 0;
    lastIndex = -2;
    if (!current) {
      status.textContent = '';
      return;
    }
    if (!lyrics) {
      status.textContent = lastLyricsError ? 'Sin conexión con las letras' : 'No se encontró la letra';
      body.appendChild(h('p', { class: 'muted' }, lastLyricsError ? `No se pudo consultar la letra: ${lastLyricsError}.` : `No hay letra para "${current.name}" en LRCLIB ni en lyrics.ovh.`));
      return;
    }
    status.textContent = '';
    if (lyrics.synced.length) {
      // Espacio arriba y abajo para que también la primera y la última línea puedan quedar centradas.
      const spacer = () => {
        const el = h('div', { class: 'lyric-spacer' });
        el.style.height = `${Math.max(60, Math.round((body.clientHeight || 200) / 2) - 24)}px`;
        return el;
      };
      body.appendChild(spacer());
      for (const line of lyrics.synced) {
        const lineEl = h('p', { class: 'lyric-line' }, line.text || '♪');
        lineEls.push(lineEl);
        body.appendChild(lineEl);
      }
      body.appendChild(spacer());
      tick();
      stopTimer();
      timer = window.setInterval(tick, 250);
    } else {
      for (const text of lyrics.plain.split('\n')) body.appendChild(h('p', { class: 'lyric-line' }, text || '♪'));
    }
  }

  return {
    el,
    show(track, newClock) {
      clock = newClock;
      if (track?.id === current?.id && track !== null) {
        tick();
        return;
      }
      current = track;
      lyrics = null;
      stopTimer();
      clear(body);
      if (!track) {
        status.textContent = '';
        return;
      }
      status.textContent = 'Buscando la letra…';
      const requested = track.id;
      void fetchLyrics(track).then((found) => {
        if (current?.id !== requested) return;
        lyrics = found;
        render();
      });
    },
    setClock(newClock) {
      clock = newClock;
      tick();
    },
    destroy() {
      stopTimer();
      el.remove();
    },
  };
}

/** Botón para mostrar u ocultar el panel (para pantallas pequeñas). */
export function lyricsToggle(panel: LyricsPanel, label = 'Letra'): HTMLButtonElement {
  const btn = button(`🎤 Ocultar ${label.toLowerCase()}`, () => {
    panel.el.hidden = !panel.el.hidden;
    btn.textContent = panel.el.hidden ? `🎤 Mostrar ${label.toLowerCase()}` : `🎤 Ocultar ${label.toLowerCase()}`;
  }, 'btn btn-sm');
  return btn;
}
