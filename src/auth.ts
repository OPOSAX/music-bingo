/**
 * Autenticación con Spotify mediante Authorization Code + PKCE.
 * Todo ocurre en el navegador: no hace falta client secret ni servidor.
 */

const CLIENT_ID_KEY = 'musicbingo:clientId';

/** Client ID de la app registrada en el panel de Spotify (no es secreto: viaja en la URL de login). */
export const DEFAULT_CLIENT_ID = '3c5a65d377d44d5ba71999598585e031';
const TOKENS_KEY = 'musicbingo:tokens';
const VERIFIER_KEY = 'musicbingo:pkce';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

export const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
];

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Momento (ms desde epoch) en el que caduca el access token. */
  expiresAt: number;
}

export class AuthError extends Error {}

export function getClientId(): string {
  return localStorage.getItem(CLIENT_ID_KEY) || DEFAULT_CLIENT_ID;
}

export function setClientId(id: string): void {
  const value = id.trim();
  if (value) localStorage.setItem(CLIENT_ID_KEY, value);
  else localStorage.removeItem(CLIENT_ID_KEY);
}

/** Permite mostrar el formulario de Client ID aunque exista uno por defecto. */
export function isUsingDefaultClientId(): boolean {
  return !localStorage.getItem(CLIENT_ID_KEY);
}

/**
 * URI de redirección: la propia página (sin query, hash ni "index.html").
 * Debe registrarse tal cual en el panel de Spotify, p. ej. https://www.paolosaxton.com/bingomusical/
 */
export function redirectUri(): string {
  return `${location.origin}${location.pathname.replace(/index\.html$/, '')}`;
}

function readTokens(): StoredTokens | null {
  try {
    const raw = localStorage.getItem(TOKENS_KEY);
    return raw ? (JSON.parse(raw) as StoredTokens) : null;
  } catch {
    return null;
  }
}

function writeTokens(tokens: StoredTokens | null): void {
  if (tokens) localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
  else localStorage.removeItem(TOKENS_KEY);
}

export function isLoggedIn(): boolean {
  return readTokens() !== null;
}

export function logout(): void {
  writeTokens(null);
}

function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

async function sha256Base64Url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Redirige a Spotify para iniciar sesión. */
export async function login(): Promise<void> {
  const clientId = getClientId();
  if (!clientId) throw new AuthError('Configura primero el Client ID de tu app de Spotify.');
  if (!crypto.subtle) {
    throw new AuthError('Este navegador no permite cifrado en esta dirección. Usa https:// o http://127.0.0.1.');
  }
  const verifier = randomString(64);
  const state = randomString(16);
  sessionStorage.setItem(VERIFIER_KEY, JSON.stringify({ verifier, state }));
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SCOPES.join(' '),
    code_challenge_method: 'S256',
    code_challenge: await sha256Base64Url(verifier),
    state,
  });
  location.assign(`${AUTH_URL}?${params}`);
}

async function tokenRequest(body: Record<string, string>): Promise<StoredTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new AuthError(data.error_description || data.error || `Error ${res.status} al obtener el token.`);
  }
  const previous = readTokens();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? previous?.refreshToken ?? '',
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

/**
 * Si la URL contiene la respuesta de Spotify (?code=...), intercambia el código por tokens.
 * Devuelve true si se ha procesado un inicio de sesión.
 */
export async function handleRedirect(): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return false;

  const cleanUrl = `${location.pathname}${location.hash || ''}`;
  history.replaceState(null, '', cleanUrl);

  if (error) throw new AuthError(`Spotify ha rechazado el acceso: ${error}`);

  const stored = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  if (!stored) throw new AuthError('La sesión de inicio ha caducado. Vuelve a intentarlo.');
  const { verifier, state } = JSON.parse(stored) as { verifier: string; state: string };
  if (params.get('state') !== state) throw new AuthError('El estado de la autorización no coincide.');

  const tokens = await tokenRequest({
    client_id: getClientId(),
    grant_type: 'authorization_code',
    code: code as string,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });
  writeTokens(tokens);
  return true;
}

let refreshing: Promise<string> | null = null;

/** Devuelve un access token válido, refrescándolo si está a punto de caducar. */
export async function getAccessToken(force = false): Promise<string> {
  const tokens = readTokens();
  if (!tokens) throw new AuthError('No has iniciado sesión en Spotify.');
  if (!force && tokens.expiresAt - Date.now() > 60_000) return tokens.accessToken;
  if (!tokens.refreshToken) {
    writeTokens(null);
    throw new AuthError('La sesión ha caducado. Vuelve a iniciar sesión.');
  }
  if (!refreshing) {
    refreshing = tokenRequest({
      client_id: getClientId(),
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    })
      .then((fresh) => {
        writeTokens(fresh);
        return fresh.accessToken;
      })
      .catch((err) => {
        writeTokens(null);
        throw err;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}
