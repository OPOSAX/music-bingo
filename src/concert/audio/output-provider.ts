/** Salida del audio procesado: por ahora la salida del AudioContext, con selección de dispositivo (USB → mixer). */

export interface AudioOutputProvider {
  readonly label: string;
  connect(ctx: AudioContext, source: AudioNode): Promise<void>;
  disconnect(): void;
}

/** Salida del navegador del DJ hacia el dispositivo elegido (p. ej. Output 1/2 de la interfaz USB → mixer). */
export class BrowserOutputProvider implements AudioOutputProvider {
  readonly label: string;
  private source: AudioNode | null = null;
  constructor(public deviceId = '') {
    this.label = deviceId ? `Salida ${deviceId.slice(0, 6)}…` : 'Salida por defecto';
  }

  static async listOutputs(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audiooutput');
  }

  async connect(ctx: AudioContext, source: AudioNode): Promise<void> {
    this.disconnect();
    this.source = source;
    const sinkable = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (this.deviceId && typeof sinkable.setSinkId === 'function') await sinkable.setSinkId(this.deviceId);
    source.connect(ctx.destination);
  }

  disconnect(): void {
    this.source?.disconnect();
    this.source = null;
  }
}
