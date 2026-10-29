import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { nowIso } from '../db/index.js';
import { ApiError } from '../http/errors.js';
import { accountForJellyfinUser } from '../services/jellyfin-accounts.js';
import type { UserService } from '../services/users.js';
import { toSessionUser } from './auth.js';
import { randomToken, safeEqual } from './crypto.js';

/**
 * The JellyWatcher plugin for Jellyfin talks to JellyWatcher server-to-server. Jellyfin has already
 * authenticated the person; the plugin proves it is the plugin with a shared key and says which
 * Jellyfin user the request is for. Such requests carry no cookie and can only reach the routes the
 * plugin's Watchlists page needs.
 */

export const PLUGIN_KEY_HEADER = 'x-jw-plugin-key';
export const PLUGIN_USER_HEADER = 'x-jw-jellyfin-user';
export const PLUGIN_NAME_HEADER = 'x-jw-jellyfin-name';
export const PLUGIN_VERSION_HEADER = 'x-jw-plugin-version';
export const PLUGIN_SERVER_HEADER = 'x-jw-jellyfin-server';

const SETTING_KEY = 'internal.pluginKey';

interface PluginRoute {
  method: 'GET' | 'POST' | 'PUT';
  path: RegExp;
  /** Whether the request acts for a person (needs the Jellyfin user header). */
  user: boolean;
}

/** Everything the plugin may call. Anything else, admin routes included, is refused. */
export const PLUGIN_ROUTES: PluginRoute[] = [
  { method: 'GET', path: /^\/api\/plugin\/status$/, user: false },
  { method: 'GET', path: /^\/api\/images\/tmdb\/w\d{2,4}\/[A-Za-z0-9_-]{1,100}\.(jpg|jpeg|png|webp)$/i, user: false },
  { method: 'GET', path: /^\/api\/plugin\/mirrors$/, user: false },
  { method: 'POST', path: /^\/api\/plugin\/mirrors\/report$/, user: false },
  { method: 'GET', path: /^\/api\/plugin\/bootstrap$/, user: true },
  { method: 'GET', path: /^\/api\/lists$/, user: true },
  { method: 'GET', path: /^\/api\/lists\/\d{1,12}(\/timeline)?$/, user: true },
  { method: 'POST', path: /^\/api\/lists\/\d{1,12}\/sync$/, user: true },
  { method: 'PUT', path: /^\/api\/lists\/\d{1,12}\/mirror$/, user: true },
  { method: 'POST', path: /^\/api\/lists\/(link|local|trakt)$/, user: true },
  { method: 'GET', path: /^\/api\/titles\/\d{1,12}\/eligibility$/, user: true },
  { method: 'POST', path: /^\/api\/titles\/\d{1,12}\/request$/, user: true },
  { method: 'PUT', path: /^\/api\/titles\/\d{1,12}\/(skipped|watched)$/, user: true },
];

export function pluginRouteFor(method: string, url: string): PluginRoute | null {
  let path = url.split('?')[0]!;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return PLUGIN_ROUTES.find((r) => r.method === method && r.path.test(path)) ?? null;
}

const JELLYFIN_ID = /^[a-f0-9]{32}$/;

export interface PluginSeen {
  at: string;
  version: string | null;
  jellyfinServerId: string | null;
}

/** Plugin key storage (encrypted, like the webhook token) and the last time the plugin called in. */
export class PluginKeys {
  private cached: { key: string | null } | null = null;
  seen: PluginSeen | null = null;

  constructor(private readonly ctx: AppContext) {}

  get(): string | null {
    if (this.cached) return this.cached.key;
    const row = this.ctx.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTING_KEY) as { value: string } | undefined;
    let key: string | null = null;
    if (row) {
      try {
        key = this.ctx.box.decrypt(JSON.parse(row.value) as string);
      } catch {
        key = null;
      }
    }
    this.cached = { key };
    return key;
  }

  /** Creates a new key; any plugin still using the old one stops working. */
  regenerate(): string {
    const key = `jwp_${randomToken(32)}`;
    this.ctx.db
      .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(SETTING_KEY, JSON.stringify(this.ctx.box.encrypt(key)), nowIso());
    this.cached = { key };
    this.seen = null;
    return key;
  }

  remove(): void {
    this.ctx.db.prepare('DELETE FROM app_settings WHERE key = ?').run(SETTING_KEY);
    this.cached = { key: null };
    this.seen = null;
  }
}

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
};

/**
 * Authenticates a request that carries the plugin key. Returns false when the request is not a
 * plugin request; throws when it claims to be one but is not allowed.
 */
export async function authenticatePluginRequest(req: FastifyRequest, ctx: AppContext, keys: PluginKeys, users: UserService): Promise<boolean> {
  const presented = header(req, PLUGIN_KEY_HEADER);
  if (presented === undefined) return false;
  const key = keys.get();
  if (!key || !safeEqual(presented, key)) {
    req.log.warn('plugin request with a wrong or disabled key');
    throw new ApiError(401, 'plugin_key', 'The JellyWatcher plugin key is not valid. Copy the current key from JellyWatcher › Integrations › Jellyfin into the plugin settings.');
  }
  const route = pluginRouteFor(req.method, req.url);
  if (!route) throw new ApiError(403, 'plugin_forbidden', 'The Jellyfin plugin cannot use this part of JellyWatcher.');
  req.viaPlugin = true;
  const version = header(req, PLUGIN_VERSION_HEADER);
  const server = header(req, PLUGIN_SERVER_HEADER);
  const serverId = server && /^[A-Za-z0-9-]{1,64}$/.test(server) ? server.replace(/-/g, '').toLowerCase() : null;
  keys.seen = {
    at: nowIso(),
    version: version && /^[0-9.]{1,20}$/.test(version) ? version : null,
    jellyfinServerId: serverId,
  };
  // Jellyfin user ids are only meaningful on their own server. A key copied to another (or a cloned)
  // Jellyfin server must not map that server's users onto these accounts.
  const known = ctx.integrations.get('jellyfin').serverInfo?.serverId;
  const expected = typeof known === 'string' && known ? known.replace(/-/g, '').toLowerCase() : null;
  if (expected && serverId && serverId !== expected) {
    req.log.warn({ serverId, expected }, 'plugin request from another Jellyfin server');
    throw new ApiError(403, 'plugin_server', 'This JellyWatcher is connected to a different Jellyfin server. Use the plugin on that server, or connect JellyWatcher to this one.');
  }
  if (!route.user) return true;

  const userId = (header(req, PLUGIN_USER_HEADER) ?? '').replace(/-/g, '').toLowerCase();
  if (!JELLYFIN_ID.test(userId)) throw new ApiError(400, 'plugin_user', 'The plugin did not say which Jellyfin user this is for.');
  let name = '';
  try {
    name = decodeURIComponent(header(req, PLUGIN_NAME_HEADER) ?? '').slice(0, 128);
  } catch {
    name = '';
  }
  const row = await accountForJellyfinUser(ctx, users, { userId, name });
  req.user = toSessionUser(row);
  return true;
}
