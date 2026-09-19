/**
 * Fuentes de MUSIC_REFERENCE para el cancelador. La preferida en producción es la entrada
 * de una interfaz USB que recibe el AUX/MATRIX del mixer (copia eléctrica de lo que va al PA).
 */

import type { ReferenceAudioMode } from '../protocol.js';

export interface ReferenceMetadata {
  title?: string;
  artist?: string;
  uri?: string;
  positionMs?: number;
  playing?: boolean;
  /** Momento (ms) al que corresponde positionMs. */
  t?: number;
}

export interface ReferenceAudioProvider {
  readonly kind: ReferenceAudioMode;
  readonly label: string;
  /** true si entrega audio real (MediaStream/AudioNode); false si solo metadata. */
  readonly hasAudio: boolean;
  start(ctx: AudioContext): Promise<AudioNode | null>;
  stop(): void;
  metadata(): ReferenceMetadata | null;
}

/** Sin referencia: el AEC queda desactivado de hecho. */
export class NullReferenceProvider implements ReferenceAudioProvider {
  readonly kind = 'NONE' as const;
  readonly label = 'Sin referencia';
  readonly hasAudio = false;
  async start(): Promise<AudioNode | null> {
    return null;
  }
  stop(): void {
    /* nada */
  }
  metadata(): ReferenceMetadata | null {
    return null;
  }
}

/** Entrada de una interfaz de audio (USB): AUX/MATRIX del mixer → Input N. PRIORITARIO en producción. */
export class MixerInputReferenceProvider implements ReferenceAudioProvider {
  readonly kind = 'MIXER' as const;
  readonly hasAudio = true;
  private stream: MediaStream | null = null;
  private node: MediaStreamAudioSourceNode | null = null;

  constructor(
    public deviceId: string,
    public readonly label = 'Mixer AUX/MATRIX (interfaz USB)',
    /** Canal de la entrada que lleva la referencia (0 = Input 1). */
    public channel = 0,
  ) {}

  /** Entradas de audio disponibles (requiere haber concedido permiso de micrófono alguna vez para ver los nombres). */
  static async listInputs(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }

  async start(ctx: AudioContext): Promise<AudioNode> {
    this.stop();
    // Sin procesado del navegador: la referencia debe ser lo más fiel posible a la señal del mixer.
    const audio: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48000 },
    };
    if (this.deviceId) audio.deviceId = { exact: this.deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    this.node = ctx.createMediaStreamSource(this.stream);
    if (this.channel > 0) {
      const splitter = ctx.createChannelSplitter(this.channel + 1);
      const merger = ctx.createChannelMerger(1);
      this.node.connect(splitter);
      splitter.connect(merger, this.channel, 0);
      return merger;
    }
    return this.node;
  }

  stop(): void {
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  metadata(): ReferenceMetadata | null {
    return null;
  }
}

/** Reproductor interno (archivo/elemento de audio en el navegador del DJ): referencia perfecta cuando la música sale de aquí. */
export class InternalPlayerReferenceProvider implements ReferenceAudioProvider {
  readonly kind = 'INTERNAL' as const;
  readonly label = 'Reproductor interno';
  readonly hasAudio = true;
  private node: AudioNode | null = null;
  constructor(private readonly source: HTMLMediaElement | MediaStream | AudioNode) {}
  async start(ctx: AudioContext): Promise<AudioNode> {
    if (this.source instanceof AudioNode) this.node = this.source;
    else if (this.source instanceof MediaStream) this.node = ctx.createMediaStreamSource(this.source);
    else this.node = ctx.createMediaElementSource(this.source);
    return this.node;
  }
  stop(): void {
    this.node?.disconnect();
    this.node = null;
  }
  metadata(): ReferenceMetadata | null {
    if (this.source instanceof HTMLMediaElement) return { positionMs: this.source.currentTime * 1000, playing: !this.source.paused, t: Date.now() };
    return null;
  }
}

/**
 * Spotify: solo METADATA_ONLY. El audio del Web Playback SDK va protegido (DRM) y no se puede
 * capturar; la sincronización (canción, posición, estado) sirve para el panel y para alinear
 * clips de prueba. AUDIO_REFERENCE quedaría disponible solo con una fuente PCM autorizada.
 */
export class SpotifyReferenceProvider implements ReferenceAudioProvider {
  readonly kind = 'SPOTIFY' as const;
  readonly label = 'Spotify (solo metadata)';
  readonly hasAudio = false;
  readonly mode: 'METADATA_ONLY' | 'AUDIO_REFERENCE' = 'METADATA_ONLY';
  private current: ReferenceMetadata | null = null;
  constructor(private readonly read: () => ReferenceMetadata | null) {}
  async start(): Promise<AudioNode | null> {
    return null;
  }
  stop(): void {
    /* nada */
  }
  metadata(): ReferenceMetadata | null {
    this.current = this.read();
    return this.current;
  }
}
