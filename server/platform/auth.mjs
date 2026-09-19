/** Tokens de acceso (admin, animadores, jugadores): solo se guarda el hash; comparación en tiempo constante. */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function newToken(prefix) {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function tokenMatches(token, hash) {
  if (!token || !hash) return false;
  const a = Buffer.from(hashToken(token));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newId(prefix) {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

/** Resuelve quién llama a partir de un token Bearer: admin de plataforma, animador o jugador. */
export function identify(store, token, adminTokenHash) {
  if (!token) return { role: 'ANON' };
  if (adminTokenHash && tokenMatches(token, adminTokenHash)) return { role: 'PLATFORM_ADMIN', id: 'admin' };
  const hash = hashToken(token);
  const user = store.find('users', (u) => u.tokenHash === hash);
  if (user) return user.status === 'SUSPENDED' ? { role: 'SUSPENDED', id: user.id, user } : { role: user.role, id: user.id, user };
  const player = store.find('players', (p) => p.tokenHash === hash);
  if (player) return { role: 'PLAYER', id: player.id, player };
  return { role: 'ANON' };
}
