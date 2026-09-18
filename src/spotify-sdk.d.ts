/** Tipos mínimos del Spotify Web Playback SDK (https://developer.spotify.com/documentation/web-playback-sdk). */

declare namespace Spotify {
  interface PlayerInit {
    name: string;
    getOAuthToken(cb: (token: string) => void): void;
    volume?: number;
  }

  interface WebPlaybackInstance {
    device_id: string;
  }

  interface PlayerError {
    message: string;
  }

  interface TrackInfo {
    uri: string;
    id: string | null;
    name: string;
    duration_ms: number;
    artists: { name: string; uri: string }[];
    album: { name: string; uri: string; images: { url: string }[] };
  }

  interface PlaybackState {
    paused: boolean;
    position: number;
    duration: number;
    track_window: { current_track: TrackInfo };
  }

  type ErrorEvent = 'initialization_error' | 'authentication_error' | 'account_error' | 'playback_error';

  class Player {
    constructor(options: PlayerInit);
    connect(): Promise<boolean>;
    disconnect(): void;
    addListener(event: 'ready' | 'not_ready', cb: (instance: WebPlaybackInstance) => void): boolean;
    addListener(event: 'player_state_changed', cb: (state: PlaybackState | null) => void): boolean;
    addListener(event: ErrorEvent, cb: (error: PlayerError) => void): boolean;
    removeListener(event: string): boolean;
    getCurrentState(): Promise<PlaybackState | null>;
    setName(name: string): Promise<void>;
    getVolume(): Promise<number>;
    setVolume(volume: number): Promise<void>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    togglePlay(): Promise<void>;
    seek(positionMs: number): Promise<void>;
    previousTrack(): Promise<void>;
    nextTrack(): Promise<void>;
    activateElement(): Promise<void>;
  }
}

interface Window {
  onSpotifyWebPlaybackSDKReady?: () => void;
  Spotify?: typeof Spotify;
}
