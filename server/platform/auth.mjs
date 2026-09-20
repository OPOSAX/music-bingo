/** Tokens de acceso (admin, animadores, jugadores): solo se guarda el hash; comparación en tiempo constante. */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

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

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(String(password), salt, 32).toString('hex')}`;
}

export function passwordMatches(password, stored) {
  if (!stored || !password) return false;
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(scryptSync(String(password), salt, 32).toString('hex'));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const SESSION_DAYS = 30;

/** Sesión de usuario (admin o animador) abierta con usuario y contraseña; el navegador solo guarda el token. */
export function openSession(store, userId, role) {
  const token = newToken(role === 'PLATFORM_ADMIN' ? 'adm' : 'sess');
  store.insert('sessions', { id: newId('session'), tokenHash: hashToken(token), userId, role, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + SESSION_DAYS * 864e5).toISOString() });
  return token;
}

export function closeSession(store, token) {
  const hash = hashToken(token);
  const s = store.find('sessions', (x) => x.tokenHash === hash);
  if (s) store.update('sessions', s.id, { expiresAt: new Date(0).toISOString() });
}

/** Resuelve quién llama a partir de un token Bearer: sesión (admin/animador), token de API o jugador. */
export function identify(store, token, adminTokenHash) {
  if (!token) return { role: 'ANON' };
  if (adminTokenHash && tokenMatches(token, adminTokenHash)) return { role: 'PLATFORM_ADMIN', id: 'admin' };
  const hash = hashToken(token);
  const session = store.find('sessions', (s) => s.tokenHash === hash);
  if (session) {
    if (Date.parse(session.expiresAt) < Date.now()) return { role: 'ANON' };
    if (session.role === 'PLATFORM_ADMIN') return { role: 'PLATFORM_ADMIN', id: 'admin', session };
    const user = store.get('users', session.userId);
    if (!user) return { role: 'ANON' };
    return user.status === 'SUSPENDED' ? { role: 'SUSPENDED', id: user.id, user } : { role: user.role, id: user.id, user, session };
  }
  const user = store.find('users', (u) => u.tokenHash === hash);
  if (user) return user.status === 'SUSPENDED' ? { role: 'SUSPENDED', id: user.id, user } : { role: user.role, id: user.id, user };
  const player = store.find('players', (p) => p.tokenHash === hash);
  if (player) return { role: 'PLAYER', id: player.id, player };
  return { role: 'ANON' };
}
