/** The parts of jellyfin-web's global ApiClient the Watchlists page uses. */
interface JellyfinApiClient {
  getUrl(name: string, params?: Record<string, string | number | undefined>): string;
  accessToken(): string | null;
  serverId(): string;
  deviceId?(): string;
  deviceName?(): string;
  appName?(): string;
  appVersion?(): string;
  getCurrentUserId?(): string | null;
}

interface Window {
  ApiClient?: JellyfinApiClient;
  __jellyWatcherLoaded?: boolean;
}

declare module '*.css' {
  const css: string;
  export default css;
}
