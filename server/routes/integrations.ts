import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import type { AppContext } from '../context.js';
import { nowIso } from '../db/index.js';
import { normalizeServiceUrl } from '../http/client.js';
import { ApiError, ProviderError } from '../http/errors.js';
import { parse } from '../http/validate.js';
import { JellyfinClient } from '../providers/jellyfin.js';
import { SeerrClient } from '../providers/seerr.js';
import { TmdbClient } from '../providers/tmdb.js';
import { TraktClient } from '../providers/trakt.js';
import { randomToken } from '../security/crypto.js';
import { requireAdmin, requireUser } from '../security/auth.js';
import { SERVER_INTEGRATIONS, type ServerIntegration } from '../services/integrations.js';
import { triggerJob } from '../sync/scheduler.js';

const url = z.string().trim().min(1).max(500).transform((v, c) => {
  try {
    return normalizeServiceUrl(v);
  } catch (e) {
    c.addIssue({ code: 'custom', message: (e as Error).message });
    return z.NEVER;
  }
});
const optionalUrl = z.union([z.literal(''), url]).optional().transform((v) => (v ? v : undefined));
const secret = z.string().trim().max(2000).optional();

const Schemas = {
  jellyfin: z.object({ config: z.object({ url, publicUrl: optionalUrl }), secrets: z.object({ apiKey: secret }).default({}) }),
  seerr: z.object({ config: z.object({ url, publicUrl: optionalUrl }), secrets: z.object({ apiKey: secret }).default({}) }),
  tmdb: z.object({ config: z.object({}).default({}), secrets: z.object({ token: secret }).default({}) }),
  trakt: z.object({ config: z.object({ clientId: z.string().trim().regex(/^[A-Za-z0-9]{16,128}$/, 'That does not look like a Trakt Client ID.') }), secrets: z.object({ clientSecret: secret }).default({}) }),
} as const;

type TestResult = { ok: true; info: Record<string, unknown>; warnings: string[] } | { ok: false; message: string; kind?: string };

async function testIntegration(ctx: AppContext, provider: ServerIntegration, config: Record<string, unknown>, secrets: Record<string, string | undefined>): Promise<TestResult> {
  try {
    switch (provider) {
      case 'jellyfin': {
        if (!secrets.apiKey) return { ok: false, message: 'Enter an API key.' };
        const c = new JellyfinClient(String(config.url), secrets.apiKey, `jellywatcher-${ctx.settings.instanceId()}`, ctx.config.version);
        const pub = await c.publicInfo();
        let sys;
        try {
          sys = await c.systemInfo();
        } catch (err) {
          if (err instanceof ProviderError && (err.kind === 'auth' || err.kind === 'forbidden')) {
            return { ok: false, kind: 'auth', message: 'Jellyfin is reachable, but it rejected the API key. Create a key in Dashboard › API Keys.' };
          }
          throw err;
        }
        const users = await c.users();
        const warnings: string[] = [];
        const major = Number((sys.Version ?? pub.Version ?? '0').split('.')[0]);
        if (major === 10 && Number((sys.Version ?? '').split('.')[1]) < 10) warnings.push('This Jellyfin version is older than 10.10 and is not tested.');
        return { ok: true, info: { serverName: sys.ServerName ?? pub.ServerName, version: sys.Version ?? pub.Version, serverId: sys.Id ?? pub.Id, users: users.length }, warnings };
      }
      case 'seerr': {
        if (!secrets.apiKey) return { ok: false, message: 'Enter an API key.' };
        const c = new SeerrClient(String(config.url), secrets.apiKey);
        const status = await c.status();
        let me;
        try {
          me = await c.me();
        } catch (err) {
          if (err instanceof ProviderError && (err.kind === 'auth' || err.kind === 'forbidden')) {
            return { ok: false, kind: 'auth', message: 'Seerr is reachable, but it rejected the API key. Copy it from Seerr › Settings › General.' };
          }
          throw err;
        }
        const pub = await c.publicSettings().catch(() => null);
        const warnings: string[] = [];
        if (pub?.mediaServerType && pub.mediaServerType !== 2) warnings.push('This Seerr instance is not configured for Jellyfin; availability may not match your Jellyfin library.');
        return { ok: true, info: { version: status.version, applicationTitle: pub?.applicationTitle ?? 'Seerr', apiUser: me.displayName ?? me.username ?? `#${me.id}` }, warnings };
      }
      case 'tmdb': {
        if (!secrets.token) return { ok: false, message: 'Enter an API Read Access Token.' };
        await new TmdbClient(secrets.token).validate();
        return { ok: true, info: {}, warnings: [] };
      }
      case 'trakt': {
        const c = new TraktClient(String(config.clientId), secrets.clientSecret);
        await c.api.get('/lists/trending', { page: 1, limit: 1 }, { retries: 0 });
        const warnings = secrets.clientSecret ? [] : ['No Client Secret set. Device sign-in may still work, but Trakt recommends sending it from the server.'];
        return { ok: true, info: {}, warnings };
      }
    }
  } catch (err) {
    if (err instanceof ProviderError) {
      if (err.kind === 'auth' || err.kind === 'forbidden') return { ok: false, kind: err.kind, message: provider === 'trakt' ? 'Trakt rejected the Client ID.' : provider === 'tmdb' ? 'TMDb rejected the token. Use the “API Read Access Token”, not the API key.' : err.message };
      if (err.kind === 'not_found') return { ok: false, kind: err.kind, message: 'The address responded, but the API was not found. Check the URL (include any base path).' };
      return { ok: false, kind: err.kind, message: err.message };
    }
    return { ok: false, message: (err as Error).message };
  }
}

export function webhookToken(ctx: AppContext, regenerate = false): string {
  const row = ctx.db.prepare("SELECT value FROM app_settings WHERE key = 'internal.webhookToken'").get() as { value: string } | undefined;
  if (row && !regenerate) {
    try {
      return ctx.box.decrypt(JSON.parse(row.value) as string);
    } catch {
      /* regenerate below */
    }
  }
  const token = randomToken(24);
  ctx.db
    .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('internal.webhookToken', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(JSON.stringify(ctx.box.encrypt(token)), nowIso());
  return token;
}

export async function integrationRoutes(app: FastifyInstance, { ctx }: AppDeps) {
  const providerParam = z.object({ provider: z.enum(SERVER_INTEGRATIONS as [ServerIntegration, ...ServerIntegration[]]) });

  app.get('/integrations', async (req) => {
    const u = requireUser(req);
    const views = SERVER_INTEGRATIONS.map((p) => ctx.integrations.view(p));
    if (u.role === 'admin') return { integrations: views };
    // Non-admins only see whether services work, not their configuration.
    return { integrations: views.map((v) => ({ provider: v.provider, ready: v.ready, status: v.status, lastOkAt: v.lastOkAt, lastError: v.status === 'error' ? 'The service is currently unavailable.' : null })) };
  });

  app.put('/integrations/:provider', async (req) => {
    requireAdmin(req);
    const { provider } = parse(providerParam, req.params);
    const body = parse(Schemas[provider], req.body) as { config: Record<string, unknown>; secrets: Record<string, string | undefined> };
    const saved = ctx.integrations.save(provider, body.config, body.secrets);
    const test = await testIntegration(ctx, provider, saved.config, saved.secrets);
    if (test.ok) {
      ctx.integrations.markOk(provider, test.info);
      if (provider === 'jellyfin') void triggerJob(ctx, 'jellyfin', 'event');
      if (provider === 'seerr') void triggerJob(ctx, 'seerr', 'event');
      if (provider === 'tmdb' || provider === 'seerr') void triggerJob(ctx, 'match', 'event');
    } else ctx.integrations.markError(provider, new Error(test.message));
    return { integration: ctx.integrations.view(provider), test };
  });

  /** Tests unsaved values (falls back to stored secrets when a secret field is left empty). */
  app.post('/integrations/:provider/test', async (req) => {
    requireAdmin(req);
    const { provider } = parse(providerParam, req.params);
    const body = parse(Schemas[provider], req.body) as { config: Record<string, unknown>; secrets: Record<string, string | undefined> };
    const stored = ctx.integrations.get(provider).secrets;
    const secrets = { ...stored, ...Object.fromEntries(Object.entries(body.secrets).filter(([, v]) => v)) };
    return { test: await testIntegration(ctx, provider, body.config, secrets) };
  });

  app.post('/integrations/:provider/check', async (req) => {
    requireAdmin(req);
    const { provider } = parse(providerParam, req.params);
    const rec = ctx.integrations.get(provider);
    if (!ctx.integrations.isReady(provider)) throw new ApiError(400, 'not_configured', 'This integration is not configured.');
    const test = await testIntegration(ctx, provider, rec.config, rec.secrets);
    if (test.ok) ctx.integrations.markOk(provider, test.info);
    else ctx.integrations.markError(provider, new Error(test.message));
    return { integration: ctx.integrations.view(provider), test };
  });

  app.delete('/integrations/:provider', async (req) => {
    requireAdmin(req);
    const { provider } = parse(providerParam, req.params);
    ctx.integrations.remove(provider);
    if (provider === 'jellyfin') {
      // Library data from a disconnected server must not be shown as current.
      ctx.db.prepare('DELETE FROM jellyfin_items').run();
    }
    if (provider === 'seerr') ctx.db.prepare('DELETE FROM seerr_media').run();
    return { ok: true };
  });

  app.get('/integrations/webhook', async (req) => {
    requireAdmin(req);
    return { token: webhookToken(ctx) };
  });

  app.post('/integrations/webhook/regenerate', async (req) => {
    requireAdmin(req);
    return { token: webhookToken(ctx, true) };
  });
}
