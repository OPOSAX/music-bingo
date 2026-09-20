/**
 * Fábrica de sesiones Concert Mode para las vistas: elige entre B-Talk real (BTALK_URL configurada)
 * y el modo demo en memoria (un hub local compartido en la misma pestaña).
 */

import { BTalkConsumerAdapter, DemoConsumerAdapter, type ConsumerAdapter, type MediasoupRecvDeviceLike } from './consumer.js';
import { BTalkMediaAdapter, LocalMediaAdapter, type MediaTransportAdapter, type MediasoupDeviceLike } from './media-service.js';
import type { ConcertConfig, Role } from './protocol.js';
import { LocalConcertHub, connectBTalk, type ConcertSignaling } from './signaling.js';

export interface ConcertEndpoint {
  btalkUrl: string;
  roomId: string;
  token?: string;
}

export const DEMO_ROOM = 'demo';

export function endpointFromParams(params: URLSearchParams, config: ConcertConfig): ConcertEndpoint {
  const endpoint: ConcertEndpoint = { btalkUrl: (params.get('btalk') ?? config.btalkUrl).trim().replace(/\/$/, ''), roomId: (params.get('room') ?? '').trim() || DEMO_ROOM };
  const token = params.get('token');
  if (token) endpoint.token = token;
  return endpoint;
}

export function isDemo(endpoint: ConcertEndpoint): boolean {
  return !endpoint.btalkUrl;
}

/** Enlace/QR que reparte el DJ: abre la pantalla del participante en la misma sala y servidor. */
export function participantJoinUrl(endpoint: ConcertEndpoint): string {
  const base = `${location.origin}${location.pathname}`;
  const params = new URLSearchParams({ room: endpoint.roomId });
  if (endpoint.btalkUrl) params.set('btalk', endpoint.btalkUrl);
  return `${base}#/sing?${params.toString()}`;
}

/** Hub de demo compartido por las vistas /dj y /sing de la misma pestaña. */
export function demoHub(config: ConcertConfig, roomId = DEMO_ROOM): LocalConcertHub {
  const g = globalThis as { __concertHub?: LocalConcertHub };
  if (!g.__concertHub || g.__concertHub.roomId !== roomId) g.__concertHub = new LocalConcertHub({ ...config, concertMode: true }, roomId);
  return g.__concertHub;
}

export async function createSignaling(endpoint: ConcertEndpoint, role: Role, config: ConcertConfig): Promise<ConcertSignaling> {
  if (isDemo(endpoint)) return demoHub(config, endpoint.roomId).client(role);
  const auth: { token?: string; roomId: string } = { roomId: endpoint.roomId };
  if (endpoint.token) auth.token = endpoint.token;
  return connectBTalk(endpoint.btalkUrl, auth);
}

/**
 * Eventos de transporte que el servidor B-Talk expone al módulo Concert (envoltorios finos de sus
 * handlers getRouterRtpCapabilities / createWebRtcTransport / connectTransport / produce / consume).
 */
export const TRANSPORT_EVENTS = {
  rtpCapabilities: 'concert:rtp-capabilities',
  createTransport: 'concert:create-transport',
  connectTransport: 'concert:connect-transport',
  produce: 'concert:produce',
  consume: 'concert:consume',
  resumeConsumer: 'concert:resume-consumer',
} as const;

/**
 * Carga el bundle mediasoup-client de B-Talk (public/sfu/MediasoupClient.js, browserify → window.mediasoupClient)
 * que sirve el servidor Concert en /sfu/MediasoupClient.js.
 */
type MediasoupGlobal = { mediasoupClient?: { Device: new () => MediasoupDeviceLike & MediasoupRecvDeviceLike } };
let mediasoupLoading: Promise<void> | null = null;

export async function loadMediasoupDevice(btalkUrl: string): Promise<MediasoupDeviceLike & MediasoupRecvDeviceLike> {
  const g = globalThis as MediasoupGlobal;
  if (!g.mediasoupClient) {
    mediasoupLoading ??= new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${btalkUrl}/sfu/MediasoupClient.js`;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        mediasoupLoading = null;
        reject(new Error(`No se pudo cargar mediasoup-client desde ${btalkUrl}`));
      };
      document.head.appendChild(script);
    });
    await mediasoupLoading;
  }
  if (!g.mediasoupClient) throw new Error('mediasoup-client no disponible');
  return new g.mediasoupClient.Device();
}

/** Comprueba si el origen actual es un servidor Concert (sirve /health con concert:true). */
export async function detectConcertServer(): Promise<string | null> {
  return (await detectServer()).concert;
}

/** Servidor completo (Socket.IO + mediasoup) en este origen; el servidor de desarrollo sin Live devuelve null. */
export async function detectLiveServer(): Promise<string | null> {
  return (await detectServer()).live;
}

async function detectServer(): Promise<{ concert: string | null; live: string | null }> {
  try {
    const res = await fetch('health', { cache: 'no-store' });
    if (!res.ok) return { concert: null, live: null };
    const data = (await res.json()) as { concert?: boolean; live?: unknown; dev?: boolean };
    const url = data.concert ? location.origin + location.pathname.replace(/\/[^/]*$/, '').replace(/\/$/, '') : null;
    return { concert: url, live: url && data.live !== false && !data.dev ? url : null };
  } catch {
    return { concert: null, live: null };
  }
}

export type TransportEventNames = { readonly [K in keyof typeof TRANSPORT_EVENTS]: string };

/** Envoltorio de la señalización de transporte; `names` permite reutilizarlo con otro prefijo de eventos (p. ej. `live:*`). */
export function makeTransportSignaling(signaling: ConcertSignaling, names: TransportEventNames) {
  return transportSignalingWith(signaling, names);
}

function transportSignaling(signaling: ConcertSignaling) {
  return transportSignalingWith(signaling, TRANSPORT_EVENTS);
}

function transportSignalingWith(signaling: ConcertSignaling, TRANSPORT_EVENTS: TransportEventNames) {
  const unwrap = <T>(r: { ok: boolean } & Record<string, unknown>): T => {
    const { ok: _ok, ...rest } = r;
    return rest as T;
  };
  return {
    routerRtpCapabilities: async () => unwrap<{ rtpCapabilities: unknown }>(await signaling.request(TRANSPORT_EVENTS.rtpCapabilities)).rtpCapabilities,
    createWebRtcTransport: async (direction: 'send' | 'recv' = 'send') => unwrap<{ params: unknown }>(await signaling.request(TRANSPORT_EVENTS.createTransport, { direction })).params,
    connectTransport: async (transportId: string, dtlsParameters: unknown) => {
      await signaling.request(TRANSPORT_EVENTS.connectTransport, { transportId, dtlsParameters });
    },
    produce: async (transportId: string, kind: string, rtpParameters: unknown, appData: unknown) => unwrap<{ id: string }>(await signaling.request(TRANSPORT_EVENTS.produce, { transportId, kind, rtpParameters, appData })),
    consume: async (transportId: string, producerId: string, rtpCapabilities: unknown) =>
      unwrap<{ id: string; producerId: string; kind: string; rtpParameters: unknown }>(await signaling.request(TRANSPORT_EVENTS.consume, { transportId, producerId, rtpCapabilities })),
    resumeConsumer: async (consumerId: string) => {
      await signaling.request(TRANSPORT_EVENTS.resumeConsumer, { consumerId });
    },
  };
}

export async function createMediaAdapter(endpoint: ConcertEndpoint, signaling: ConcertSignaling, config: ConcertConfig): Promise<MediaTransportAdapter> {
  if (isDemo(endpoint)) {
    const hub = demoHub(config, endpoint.roomId);
    return new LocalMediaAdapter((producer) => void hub.registerProducer(producer));
  }
  return new BTalkMediaAdapter(await loadMediasoupDevice(endpoint.btalkUrl), transportSignaling(signaling));
}

export async function createConsumerAdapter(endpoint: ConcertEndpoint, signaling: ConcertSignaling, context: () => AudioContext | null): Promise<ConsumerAdapter> {
  if (isDemo(endpoint)) return new DemoConsumerAdapter(context);
  return new BTalkConsumerAdapter(await loadMediasoupDevice(endpoint.btalkUrl), transportSignaling(signaling));
}
