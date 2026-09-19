/**
 * BIZNET CROWD MIC / CONCERT MODE — contrato compartido entre teléfonos, DJ y servidor (B-Talk).
 * Este módulo no depende de nada: se compila igual para el navegador y para Node.
 */

export type ParticipantState = 'DISCONNECTED' | 'CONNECTED' | 'READY' | 'PREPARING' | 'PREPARED' | 'LIVE' | 'MUTED' | 'ERROR';

export type SlotState = 'EMPTY' | 'PREPARING' | 'PREPARED' | 'LIVE' | 'MUTED';

export type Role = 'participant' | 'dj' | 'admin' | 'audio-engine';

/** Roles autorizados a consumir producers con source=crowd-mic. */
export const CONSUMER_ROLES: readonly Role[] = ['dj', 'admin', 'audio-engine'];

/** Roles que pueden operar los slots (prepare, go-live, mute, end). */
export const OPERATOR_ROLES: readonly Role[] = ['dj', 'admin'];

export type AudioProfile = 'TALK' | 'SING';
export type NoiseReduction = 'OFF' | 'LIGHT' | 'MEDIUM' | 'STRONG';
export type ReferenceAudioMode = 'MIXER' | 'INTERNAL' | 'SPOTIFY' | 'NONE';

export type PrepareFailureReason = 'permissionDenied' | 'transportFailed' | 'producerFailed' | 'networkError';

/** Transiciones válidas de la máquina de estados (el servidor es la autoridad). */
export const TRANSITIONS: Record<ParticipantState, readonly ParticipantState[]> = {
  DISCONNECTED: ['CONNECTED'],
  CONNECTED: ['READY', 'DISCONNECTED'],
  READY: ['PREPARING', 'CONNECTED', 'DISCONNECTED'],
  PREPARING: ['PREPARED', 'ERROR', 'READY', 'DISCONNECTED'],
  PREPARED: ['LIVE', 'READY', 'DISCONNECTED'],
  LIVE: ['MUTED', 'READY', 'DISCONNECTED'],
  MUTED: ['LIVE', 'READY', 'DISCONNECTED'],
  ERROR: ['READY', 'CONNECTED', 'DISCONNECTED'],
};

export function canTransition(from: ParticipantState, to: ParticipantState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Estados en los que el participante ocupa un slot de micrófono. */
export const SLOT_STATES: readonly ParticipantState[] = ['PREPARING', 'PREPARED', 'LIVE', 'MUTED'];

export interface ParticipantMeta {
  participantId: string;
  userId?: string;
  name: string;
  avatar?: string;
  eventId?: string;
  roomId: string;
  sector?: string;
  mesa?: string;
  asiento?: string;
  device?: string;
  userAgent?: string;
}

export interface ParticipantInfo extends ParticipantMeta {
  state: ParticipantState;
  /** Momento (ms) en que pasó a READY; sirve para "tiempo esperando". */
  timestampReady?: number;
  slotId?: string;
  /** Calidad de conexión resumida. */
  quality?: ConnectionQuality;
  lastSeen: number;
}

export type ConnectionQuality = 'GOOD' | 'FAIR' | 'BAD' | 'UNKNOWN';

export interface SlotInfo {
  slotId: string;
  state: SlotState;
  participantId?: string;
  producerId?: string;
  since?: number;
}

export interface ConcertMetrics {
  connected: number;
  ready: number;
  preparing: number;
  prepared: number;
  live: number;
  muted: number;
  slots: SlotInfo[];
  nowPlaying?: { title: string; artist: string; uri?: string; positionMs?: number; playing?: boolean; t?: number } | null;
}

/** appData obligatorio del producer de un micrófono del público. */
export interface CrowdMicAppData {
  mediaType: 'audio';
  source: 'crowd-mic';
  participantId: string;
  roomId: string;
  slotId: string;
}

export function isCrowdMicAppData(appData: unknown): appData is CrowdMicAppData {
  if (!appData || typeof appData !== 'object') return false;
  const a = appData as Partial<CrowdMicAppData>;
  return a.mediaType === 'audio' && a.source === 'crowd-mic' && typeof a.participantId === 'string' && typeof a.slotId === 'string' && typeof a.roomId === 'string';
}

/** Nombres de eventos Socket.IO. */
export const EVENTS = {
  // cliente → servidor
  join: 'concert:join',
  ready: 'concert:ready',
  leave: 'concert:leave',
  prepare: 'concert:prepare', // DJ → servidor (petición) y servidor → teléfono (orden)
  prepared: 'concert:prepared', // teléfono → servidor
  prepareFailed: 'concert:prepare-failed', // teléfono → servidor
  goLive: 'concert:go-live',
  mute: 'concert:mute',
  unmute: 'concert:unmute',
  end: 'concert:end',
  stopMyMic: 'concert:stop-my-mic', // participante → servidor: siempre permitido
  list: 'concert:list', // DJ → servidor: paginación/búsqueda
  // servidor → clientes
  preparing: 'concert:preparing',
  live: 'concert:live',
  state: 'concert:state', // servidor → un participante: su estado actual
  participantAdded: 'concert:participant-added',
  participantUpdated: 'concert:participant-updated',
  participantRemoved: 'concert:participant-removed',
  metrics: 'concert:metrics',
  error: 'concert:error',
} as const;

export interface JoinPayload {
  participantId?: string;
  roomId: string;
  meta: Omit<ParticipantMeta, 'participantId' | 'roomId'>;
}

export interface JoinAck {
  participantId: string;
  state: ParticipantState;
  concertMode: boolean;
}

export interface PrepareOrder {
  slotId: string;
  profile: AudioProfile;
  /** Parámetros de transporte que entrega B-Talk (routerRtpCapabilities, etc.), opacos para este módulo. */
  transport?: unknown;
}

export interface PreparedPayload {
  slotId: string;
  producerId: string;
}

export interface PrepareFailedPayload {
  slotId: string;
  reason: PrepareFailureReason;
  detail?: string;
}

export interface ListRequest {
  state?: ParticipantState;
  query?: string;
  offset?: number;
  limit?: number;
}

export interface ListResponse {
  total: number;
  offset: number;
  items: ParticipantInfo[];
}

/** Configuración de Concert Mode (leída de variables de entorno en el servidor o de localStorage en el DJ). */
export interface ConcertConfig {
  concertMode: boolean;
  maxLiveMics: number;
  maxPreparedMics: number;
  audioProfile: AudioProfile;
  noiseReduction: NoiseReduction;
  aecEnabled: boolean;
  referenceAudioMode: ReferenceAudioMode;
  btalkUrl: string;
  btalkApiUrl: string;
}

export const DEFAULT_CONFIG: ConcertConfig = {
  concertMode: false,
  maxLiveMics: 2,
  maxPreparedMics: 2,
  audioProfile: 'SING',
  noiseReduction: 'LIGHT',
  aecEnabled: true,
  referenceAudioMode: 'MIXER',
  btalkUrl: '',
  btalkApiUrl: '',
};

/** Lee la configuración de un objeto tipo process.env (servidor) o de un mapa (navegador). */
export function readConfig(env: Record<string, string | undefined>): ConcertConfig {
  const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));
  const int = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : d;
  };
  const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[], d: T): T => (allowed.includes((v ?? '').toUpperCase() as T) ? ((v as string).toUpperCase() as T) : d);
  return {
    concertMode: bool(env.CONCERT_MODE, DEFAULT_CONFIG.concertMode),
    maxLiveMics: int(env.MAX_LIVE_MICS, DEFAULT_CONFIG.maxLiveMics),
    maxPreparedMics: int(env.MAX_PREPARED_MICS, DEFAULT_CONFIG.maxPreparedMics),
    audioProfile: oneOf(env.CONCERT_AUDIO_PROFILE, ['TALK', 'SING'], DEFAULT_CONFIG.audioProfile),
    noiseReduction: oneOf(env.CONCERT_NOISE_REDUCTION, ['OFF', 'LIGHT', 'MEDIUM', 'STRONG'], DEFAULT_CONFIG.noiseReduction),
    aecEnabled: bool(env.AEC_ENABLED, DEFAULT_CONFIG.aecEnabled),
    referenceAudioMode: oneOf(env.REFERENCE_AUDIO_MODE, ['MIXER', 'INTERNAL', 'SPOTIFY', 'NONE'], DEFAULT_CONFIG.referenceAudioMode),
    btalkUrl: env.BTALK_URL ?? '',
    btalkApiUrl: env.BTALK_API_URL ?? '',
  };
}

/** Nombres de slot genéricos: MIC_A, MIC_B, MIC_C… */
export function slotIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `MIC_${String.fromCharCode(65 + i)}`);
}
