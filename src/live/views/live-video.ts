/**
 * LiveHostVideo: vídeo del animador embebido en la pantalla del jugador, con indicador EN VIVO,
 * estado de conexión, CTA único para habilitar el audio en móvil, reacciones y modo flotante al hacer scroll.
 */

import { button, h } from '../../dom.js';
import { LIVE_EVENTS, REACTIONS, type LinkState, type LiveState, type Reaction, type ReactionBatch, type WinnerAnnouncement } from '../protocol.js';
import type { LiveSession } from '../session.js';
import { LiveViewer } from '../viewer.js';

export interface LiveHostVideoOptions {
  /** Texto del CTA que habilita el audio (una sola vez). */
  ctaLabel?: string;
  /** Activa el vídeo flotante cuando el jugador baja hasta el cartón. */
  floating?: boolean;
  onWinner?(w: WinnerAnnouncement): void;
}

export interface LiveHostVideo {
  el: HTMLElement;
  viewer: LiveViewer;
  destroy(): void;
}

const REACTION_MIN_MS = 600;

export function createLiveHostVideo(session: LiveSession, options: LiveHostVideoOptions = {}): LiveHostVideo {
  const video = h('video', { class: 'live-video', autoplay: true, playsInline: true, muted: true });
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  const badge = h('span', { class: 'live-badge live-off' }, 'OFFLINE');
  const status = h('span', { class: 'live-link-state' }, '');
  const viewers = h('span', { class: 'live-viewers muted small' }, '');
  const placeholder = h('div', { class: 'live-placeholder' }, h('div', { class: 'live-placeholder-icon' }, '🎤'), h('p', null, 'El animador todavía no está en directo.'));
  const cta = button(options.ctaLabel ?? '🔊 Entrar a Bingo Hit', () => unlock(), 'btn btn-primary btn-lg live-cta');
  const overlay = h('div', { class: 'live-overlay', hidden: true }, cta);
  const reactionsLayer = h('div', { class: 'reaction-layer' });
  const frame = h('div', { class: 'live-frame' }, video, placeholder, reactionsLayer, overlay, h('div', { class: 'live-topbar' }, badge, status, viewers));
  const bar = h('div', { class: 'live-reactions' });
  let lastReaction = 0;
  for (const emoji of REACTIONS) {
    bar.appendChild(
      button(
        emoji,
        () => {
          const now = Date.now();
          if (now - lastReaction < REACTION_MIN_MS) return;
          lastReaction = now;
          spawn(emoji, 1);
          void session.request(LIVE_EVENTS.reaction, { emoji }).catch(() => undefined);
        },
        'btn btn-sm reaction-btn',
      ),
    );
  }
  const sentinel = h('div', { class: 'live-sentinel' });
  const wrap = h('div', { class: 'live-video-wrap' }, sentinel, frame, bar);
  let unlocked = false;
  let liveState: LiveState | null = null;

  const unlock = () => {
    unlocked = true;
    video.muted = false;
    overlay.hidden = true;
    void video.play().catch(() => undefined);
  };
  const tryPlay = () => {
    if (!video.srcObject) return;
    video.muted = !unlocked;
    // Un único CTA: aparece solo cuando hay transmisión y el audio sigue bloqueado por el navegador.
    overlay.hidden = unlocked;
    void video.play().catch(() => {
      overlay.hidden = false;
    });
  };
  const setLink = (state: LinkState) => {
    const map: Record<LinkState, [string, string]> = { LIVE: ['🟢', 'EN VIVO'], RECONNECTING: ['🟡', 'RECONECTANDO…'], INTERRUPTED: ['🔴', 'TRANSMISIÓN INTERRUMPIDA'], OFFLINE: ['⚪', 'SIN CONEXIÓN'] };
    const [icon, text] = map[state];
    status.textContent = state === 'LIVE' ? (liveState ? `${icon} ${text}` : '') : liveState ? `${icon} ${text}` : `${icon} SIN CONEXIÓN CON EL EVENTO`;
    status.className = `live-link-state link-${state.toLowerCase()}`;
  };
  const spawn = (emoji: Reaction, count: number) => {
    for (let i = 0; i < Math.min(count, 12); i++) {
      const el = h('span', { class: 'reaction-float' }, emoji);
      el.style.left = `${10 + Math.random() * 80}%`;
      el.style.animationDelay = `${Math.random() * 300}ms`;
      reactionsLayer.appendChild(el);
      setTimeout(() => el.remove(), 2200);
    }
  };

  const viewer = new LiveViewer(session, {
    onStream: (stream) => {
      if (video.srcObject !== stream) video.srcObject = stream;
      tryPlay();
    },
    onLive: (state) => {
      liveState = state;
      badge.textContent = state ? '🔴 EN VIVO' : 'OFFLINE';
      badge.className = `live-badge ${state ? 'live-on' : 'live-off'}`;
      placeholder.hidden = !!state;
      wrap.classList.toggle('is-live', !!state);
      if (!state) {
        video.srcObject = null;
        overlay.hidden = true;
        wrap.classList.remove('live-floating');
      }
      setLink(session.state);
    },
    onLink: setLink,
    onHost: (online) => {
      if (!online) placeholder.querySelector('p')!.textContent = 'El animador no está conectado.';
      else if (!liveState) placeholder.querySelector('p')!.textContent = 'El animador está conectado; la transmisión empezará en breve.';
    },
    onViewers: (n) => {
      viewers.textContent = n > 0 ? `👥 ${n}` : '';
    },
    onProducerState: (p) => {
      if (p.kind === 'video') frame.classList.toggle('cam-paused', p.paused);
    },
  });
  const offs: (() => void)[] = [];
  void viewer
    .start()
    .then(() => {
      offs.push(
        session.on(LIVE_EVENTS.reactions, (b: ReactionBatch) => {
          for (const [emoji, count] of Object.entries(b.counts) as [Reaction, number][]) spawn(emoji, count);
        }),
        session.on(LIVE_EVENTS.winnerAnnounced, (w: WinnerAnnouncement) => {
          showWinner(w);
          options.onWinner?.(w);
        }),
      );
    })
    .catch(() => setLink('INTERRUPTED'));

  // Vídeo flotante: cuando el marco original sale de pantalla (el jugador está en el cartón).
  let observer: IntersectionObserver | null = null;
  if (options.floating !== false && 'IntersectionObserver' in window) {
    observer = new IntersectionObserver(
      (entries) => {
        const visible = entries[0]?.isIntersecting ?? true;
        wrap.classList.toggle('live-floating', !visible && !!liveState);
      },
      { threshold: 0.05 },
    );
    observer.observe(sentinel);
    frame.addEventListener('click', () => {
      if (wrap.classList.contains('live-floating')) sentinel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  // Al volver del segundo plano (pantalla bloqueada), el vídeo puede quedar pausado.
  const onVisible = () => {
    if (document.visibilityState === 'visible') tryPlay();
  };
  document.addEventListener('visibilitychange', onVisible);

  return {
    el: wrap,
    viewer,
    destroy: () => {
      document.removeEventListener('visibilitychange', onVisible);
      observer?.disconnect();
      offs.forEach((off) => off());
      viewer.stop();
      video.srcObject = null;
      wrap.remove();
    },
  };
}

/** Anuncio de ganador a pantalla completa, para todos. */
export function showWinner(w: WinnerAnnouncement): void {
  document.querySelector('.winner-overlay')?.remove();
  const overlay = h(
    'div',
    { class: 'winner-overlay' },
    h('div', { class: 'winner-card' }, h('div', { class: 'winner-emoji' }, '🎉'), h('h2', null, w.kind === 'line' ? '¡LÍNEA!' : '¡BINGO!'), h('p', { class: 'winner-name' }, w.name || `Tarjeta ${w.index + 1}`), h('p', { class: 'muted small' }, `Tarjeta ${w.index + 1}`), button('Cerrar', () => overlay.remove(), 'btn')),
  );
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
  navigator.vibrate?.([100, 50, 100, 50, 300]);
  setTimeout(() => overlay.remove(), 15000);
}
