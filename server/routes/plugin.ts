import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { ApiError } from '../http/errors.js';
import { parse } from '../http/validate.js';
import { requireAdmin, requireUser } from '../security/auth.js';
import { MirrorReportSchema, mirrorPayload, recordMirrorReports } from '../services/mirrors.js';

/** Plugin repository manifest to add in Jellyfin › Dashboard › Plugins › Repositories. */
export const PLUGIN_REPOSITORY_URL = 'https://raw.githubusercontent.com/TIGamingTV/JellyWatcher/main/jellyfin-plugin/manifest.json';
/** Repository of the File Transformation plugin, which the JellyWatcher plugin needs. */
export const FILE_TRANSFORMATION_REPOSITORY_URL = 'https://www.iamparadox.dev/jellyfin/plugins/manifest.json';

/** Routes for the JellyWatcher plugin for Jellyfin, and the administrator's key management. */
export async function pluginRoutes(app: FastifyInstance, { ctx, pluginKeys }: AppDeps) {
  const jellyfinServerId = () => {
    const id = ctx.integrations.get('jellyfin').serverInfo?.serverId;
    return typeof id === 'string' ? id.replace(/-/g, '').toLowerCase() : null;
  };

  /** Connection check from the plugin's settings page. */
  app.get('/plugin/status', async (req) => {
    if (!req.viaPlugin) throw new ApiError(401, 'plugin_key', 'This endpoint is for the Jellyfin plugin.');
    return { ok: true, version: ctx.config.version, jellyfin: { ready: ctx.integrations.isReady('jellyfin'), serverId: jellyfinServerId() } };
  });

  /** What the plugin's Watchlists page needs to know before it shows anything. */
  app.get('/plugin/bootstrap', async (req) => {
    const u = requireUser(req);
    const trakt = ctx.connections.get(u.id, 'trakt');
    const traktWatchlist = trakt ? Boolean(ctx.db.prepare("SELECT 1 FROM lists WHERE user_id = ? AND provider = 'trakt' AND external_id = 'watchlist'").get(u.id)) : false;
    return {
      version: ctx.config.version,
      user: { id: u.id, username: u.username, displayName: u.displayName },
      webUrl: ctx.config.publicUrl ? ctx.config.publicUrl.href : null,
      seerr: { available: ctx.integrations.isReady('seerr'), linked: u.seerrUserId !== null },
      trakt: { available: ctx.integrations.isReady('trakt'), connected: Boolean(trakt), watchlistImported: traktWatchlist },
      tmdb: { available: ctx.integrations.isReady('tmdb') },
    };
  });

  /** The collections and playlists the plugin should keep in Jellyfin, for every person. */
  app.get('/plugin/mirrors', async (req) => {
    if (!req.viaPlugin) throw new ApiError(401, 'plugin_key', 'This endpoint is for the Jellyfin plugin.');
    return mirrorPayload(ctx);
  });

  /** What the plugin did with each list (shown next to the list's Jellyfin setting). */
  app.post('/plugin/mirrors/report', async (req) => {
    if (!req.viaPlugin) throw new ApiError(401, 'plugin_key', 'This endpoint is for the Jellyfin plugin.');
    const body = parse(MirrorReportSchema, req.body);
    return { ok: true, saved: recordMirrorReports(ctx, body.results) };
  });

  const view = (key: string | null) => ({
    enabled: key !== null,
    key,
    repositoryUrl: PLUGIN_REPOSITORY_URL,
    fileTransformationRepositoryUrl: FILE_TRANSFORMATION_REPOSITORY_URL,
    lastSeen: pluginKeys.seen,
    jellyfinServerId: jellyfinServerId(),
  });

  app.get('/integrations/jellyfin-plugin', async (req) => {
    requireAdmin(req);
    return view(pluginKeys.get());
  });

  /** Turns the plugin connection on, or replaces the key (the old one stops working at once). */
  app.post('/integrations/jellyfin-plugin', async (req) => {
    requireAdmin(req);
    const key = pluginKeys.regenerate();
    ctx.log.info('Jellyfin plugin key created');
    return view(key);
  });

  app.delete('/integrations/jellyfin-plugin', async (req) => {
    requireAdmin(req);
    pluginKeys.remove();
    ctx.log.info('Jellyfin plugin key removed');
    return view(null);
  });
}
