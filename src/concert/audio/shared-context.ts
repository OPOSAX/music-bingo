/**
 * Un único AudioContext para todo el audio del anfitrión (karaoke, mesa de mezcla, medidores): los nodos de
 * Web Audio solo se pueden conectar entre sí dentro del mismo contexto. Se crea en el primer clic del
 * anfitrión (política de reproducción automática del navegador) y se reutiliza.
 */

let shared: AudioContext | null = null;

export function getSharedAudioContext(): AudioContext | null {
  if (shared && shared.state !== 'closed') {
    if (shared.state === 'suspended') void shared.resume().catch(() => undefined);
    return shared;
  }
  const Ctx = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  shared = new Ctx({ latencyHint: 'interactive' });
  return shared;
}
