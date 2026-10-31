import type { Eligibility, EpisodeGuide, JellyfinMirrorMode, ListView, Timeline } from '../../web/src/lib/types';

/** Calls to JellyWatcher, sent through the plugin with the person's Jellyfin session. */

export interface Bootstrap {
  version: string;
  user: { id: number; username: string; displayName: string };
  webUrl: string | null;
  seerr: { available: boolean; linked: boolean };
  trakt: { available: boolean; connected: boolean; watchlistImported: boolean };
  tmdb: { available: boolean };
}

export interface PageSettings {
  enabled: boolean;
  configured: boolean;
  menuLabel: string;
  publicUrl: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function client(): JellyfinApiClient {
  if (!window.ApiClient) throw new ApiError(0, 'not_ready', 'Jellyfin is still starting. Try again in a moment.');
  return window.ApiClient;
}

/** The same Authorization header jellyfin-web sends. */
function authorization(c: JellyfinApiClient): string {
  const fields: [string, string | null | undefined][] = [
    ['Client', c.appName?.() ?? 'Jellyfin Web'],
    ['Device', c.deviceName?.()],
    ['DeviceId', c.deviceId?.()],
    ['Version', c.appVersion?.()],
    ['Token', c.accessToken()],
  ];
  return `MediaBrowser ${fields
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}="${encodeURIComponent(v!)}"`)
    .join(', ')}`;
}

async function request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const c = client();
  const headers: Record<string, string> = { Accept: 'application/json', Authorization: authorization(c) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(c.getUrl(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'network', 'Jellyfin could not be reached. Check your connection.');
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    if (res.status === 401) throw new ApiError(401, 'jellyfin_auth', 'Your Jellyfin session has ended. Sign in to Jellyfin again.');
    const e = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status}).`);
  }
  return data as T;
}

const jw = <T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) => request<T>(method, `JellyWatcher/api/${path}`, body);

export const api = {
  settings: () => request<PageSettings>('GET', 'JellyWatcher/Settings'),
  bootstrap: () => jw<Bootstrap>('GET', 'plugin/bootstrap'),
  lists: () => jw<{ lists: ListView[] }>('GET', 'lists'),
  list: (id: number) => jw<{ list: ListView }>('GET', `lists/${id}`),
  timeline: (id: number) => jw<Timeline>('GET', `lists/${id}/timeline`),
  sync: (id: number) => jw<{ list: ListView }>('POST', `lists/${id}/sync`, {}),
  mirror: (id: number, mode: JellyfinMirrorMode | null) => jw<{ list: ListView }>('PUT', `lists/${id}/mirror`, { mode }),
  /** Asks the plugin to update the Jellyfin collections and playlists now instead of at the next interval. */
  applyMirrors: () => request<{ started: boolean }>('POST', 'JellyWatcher/Mirrors/Sync', {}),
  addLink: (url: string) => jw<{ list: ListView }>('POST', 'lists/link', { url }),
  addLocal: (name: string) => jw<{ list: ListView }>('POST', 'lists/local', { name }),
  addTraktWatchlist: () => jw<{ list: ListView }>('POST', 'lists/trakt', { mode: 'watchlist' }),
  episodes: (titleId: number) => jw<EpisodeGuide>('GET', `titles/${titleId}/episodes`),
  eligibility: (titleId: number) => jw<Eligibility>('GET', `titles/${titleId}/eligibility`),
  request: (titleId: number, seasons?: number[]) => jw<{ ok: true; message: string }>('POST', `titles/${titleId}/request`, seasons ? { seasons } : {}),
  skip: (titleId: number, skipped: boolean, scope: { season?: number | null; episode?: number | null }) => jw<{ ok: true; skipped: boolean }>('PUT', `titles/${titleId}/skipped`, { skipped, ...scope }),
  watched: (titleId: number, watched: boolean, scope: { season?: number | null; episode?: number | null }) => jw<unknown>('PUT', `titles/${titleId}/watched`, { watched, ...scope }),
};

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/**
 * Artwork URLs from JellyWatcher point at its own image proxy; on Jellyfin they come from the
 * plugin (TMDb) or from Jellyfin itself (library items).
 */
export function imageUrl(url: string | null | undefined): string | null {
  const c = window.ApiClient;
  if (!url || !c) return null;
  const tmdb = /^\/api\/images\/tmdb\/w\d+\/([A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp))$/i.exec(url);
  if (tmdb) return c.getUrl(`JellyWatcher/img/tmdb/w185/${tmdb[1]}`);
  const jf = /^\/api\/images\/jellyfin\/([a-f0-9-]{32,36})(?:\?tag=([A-Za-z0-9]+))?/i.exec(url);
  if (jf) return c.getUrl(`Items/${jf[1]}/Images/Primary`, { tag: jf[2], maxWidth: 200, quality: 90 });
  return null;
}
