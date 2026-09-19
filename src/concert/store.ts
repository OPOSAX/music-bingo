/** Persistencia del cliente Concert Mode: identidad estable del participante y configuración del DJ. */

import { DEFAULT_CONFIG, readConfig, type ConcertConfig } from './protocol.js';

const PID_KEY = 'concert:participantId';
const NAME_KEY = 'concert:name';
const CONFIG_KEY = 'concert:config';
const DEVICES_KEY = 'concert:devices';

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** participantId persistente: sobrevive a recargas y reconexiones para conservar el sitio en la lista READY. */
export function participantId(): string {
  const s = storage();
  let id = s?.getItem(PID_KEY) ?? '';
  if (!id) {
    id = randomId();
    s?.setItem(PID_KEY, id);
  }
  return id;
}

export function savedName(): string {
  return storage()?.getItem(NAME_KEY) ?? '';
}

export function saveName(name: string): void {
  storage()?.setItem(NAME_KEY, name.trim());
}

/** Configuración del DJ (mismas claves que las variables de entorno del servidor). */
export function loadConfig(): ConcertConfig {
  const raw = storage()?.getItem(CONFIG_KEY);
  if (!raw) return { ...DEFAULT_CONFIG, concertMode: true };
  try {
    const env = JSON.parse(raw) as Record<string, string | undefined>;
    return readConfig({ CONCERT_MODE: 'true', ...env });
  } catch {
    return { ...DEFAULT_CONFIG, concertMode: true };
  }
}

export function saveConfig(config: ConcertConfig): void {
  const env: Record<string, string> = {
    CONCERT_MODE: String(config.concertMode),
    MAX_LIVE_MICS: String(config.maxLiveMics),
    MAX_PREPARED_MICS: String(config.maxPreparedMics),
    CONCERT_AUDIO_PROFILE: config.audioProfile,
    CONCERT_NOISE_REDUCTION: config.noiseReduction,
    AEC_ENABLED: String(config.aecEnabled),
    REFERENCE_AUDIO_MODE: config.referenceAudioMode,
    BTALK_URL: config.btalkUrl,
    BTALK_API_URL: config.btalkApiUrl,
  };
  storage()?.setItem(CONFIG_KEY, JSON.stringify(env));
}

export interface DevicePrefs {
  referenceInputId?: string;
  referenceChannel?: number;
  outputId?: string;
}

export function loadDevicePrefs(): DevicePrefs {
  try {
    return JSON.parse(storage()?.getItem(DEVICES_KEY) ?? '{}') as DevicePrefs;
  } catch {
    return {};
  }
}

export function saveDevicePrefs(prefs: DevicePrefs): void {
  storage()?.setItem(DEVICES_KEY, JSON.stringify(prefs));
}
