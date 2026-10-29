import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { normalizeServiceUrl } from '../http/client.js';
import { ApiError, ProviderError } from '../http/errors.js';
import { parse } from '../http/validate.js';
import type { JellyfinClient, JellyfinSignIn } from '../providers/jellyfin.js';
import { clearSessionCookie, requireUser, setSessionCookie } from '../security/auth.js';
import { randomToken, safeEqual } from '../security/crypto.js';
import { verifyPassword } from '../security/passwords.js';
import { SOURCE_DESCRIPTORS } from '../providers/types.js';
import { QUICK_CONNECT_POLL_MS } from '../services/quickconnect.js';
import { accountForJellyfinUser, usernameFromJellyfin } from '../services/jellyfin-accounts.js';
import { triggerJob } from '../sync/scheduler.js';

const LOGIN_LIMIT = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
const QC_START_LIMIT = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
const QC_POLL_LIMIT = { config: { rateLimit: { max: 90, timeWindow: '1 minute' } } };

const ServerUrl = z.string().trim().min(1).max(500).transform((v, c) => {
  try {
    return normalizeServiceUrl(v);
  } catch (e) {
    c.addIssue({ code: 'custom', message: (e as Error).message });
    return z.NEVER;
  }
});

export { usernameFromJellyfin };

export async function authRoutes(app: FastifyInstance, { ctx, users, sessions, setupCode, quickConnect }: AppDeps) {
  const startSession = (req: FastifyRequest, reply: FastifyReply, userId: number) => {
    const s = sessions.create(userId, { userAgent: req.headers['user-agent'], ip: req.ip });
    setSessionCookie(reply, req, ctx, s.token, s.expiresAt);
    return s;
  };

  const checkSetupCode = (code: string) => {
    if (users.count() > 0) throw new ApiError(409, 'already_setup', 'JellyWatcher is already set up. Sign in instead.');
    const expected = setupCode();
    if (!expected || !safeEqual(code.trim(), expected)) {
      throw new ApiError(403, 'bad_setup_code', 'That setup code is not correct. Find it in the container logs (docker logs jellywatcher).');
    }
  };

  const loginClient = () => {
    if (!ctx.settings.get('auth.jellyfinLogin')) throw new ApiError(403, 'disabled', 'Signing in with Jellyfin is turned off.');
    const client = ctx.integrations.jellyfin();
    if (!client) throw new ApiError(503, 'jellyfin_unavailable', 'Jellyfin is not configured.');
    return client;
  };

  /** Finds (or, when allowed, creates) the JellyWatcher account of a verified Jellyfin user. */
  const accountFor = (verified: Pick<JellyfinSignIn, 'userId' | 'name' | 'disabled'>) => accountForJellyfinUser(ctx, users, verified);

  /**
   * Guided setup, like Seerr: a Jellyfin administrator signs in, JellyWatcher creates its own API
   * key with that session, saves the server, and the administrator becomes JellyWatcher's admin.
   */
  const completeJellyfinSetup = async (req: FastifyRequest, reply: FastifyReply, client: JellyfinClient, url: string, s: JellyfinSignIn, allowAll: boolean) => {
    try {
      if (!s.isAdmin) throw new ApiError(403, 'not_admin', 'Sign in with a Jellyfin administrator account to set up JellyWatcher.');
      if (users.count() > 0) throw new ApiError(409, 'already_setup', 'JellyWatcher is already set up. Sign in instead.');
      const apiKey = await client.createApiKey(s);
      ctx.integrations.save('jellyfin', { url }, { apiKey });
      const info = await ctx.integrations
        .jellyfin()!
        .systemInfo()
        .catch(() => null);
      ctx.integrations.markOk('jellyfin', info ? { serverName: info.ServerName, version: info.Version, serverId: info.Id } : undefined);
      ctx.settings.update({ 'auth.jellyfinLogin': true, 'auth.jellyfinAutoCreate': allowAll });
      const id = await users.create({
        username: usernameFromJellyfin(s.name, s.userId),
        displayName: s.name,
        role: 'admin',
        authSource: 'jellyfin',
        jellyfinUserId: s.userId,
        jellyfinUsername: s.name,
      });
      ctx.log.info({ userId: id }, 'initial administrator created from Jellyfin');
      void triggerJob(ctx, 'jellyfin', 'event');
      const session = startSession(req, reply, id);
      return { ok: true, csrfToken: session.csrf };
    } finally {
      await client.endSession(s);
    }
  };

  const setupFailure = (err: unknown): never => {
    if (err instanceof ProviderError) {
      if (err.kind === 'auth') throw new ApiError(401, 'invalid_credentials', 'Jellyfin rejected that username or password.');
      if (err.kind === 'forbidden') throw new ApiError(400, 'jellyfin_forbidden', err.message);
      if (err.kind === 'network' || err.kind === 'timeout' || err.kind === 'unavailable' || err.kind === 'not_found' || err.kind === 'invalid_response') {
        throw new ApiError(400, 'jellyfin_unreachable', 'No Jellyfin server answered at that address. Check the URL, including http(s):// and any base path.');
      }
    }
    throw err;
  };

  // Quick Connect support is checked at most once a minute (the login page asks on every load).
  let qcCache: { at: number; enabled: boolean } | null = null;
  const quickConnectEnabled = async () => {
    const client = ctx.integrations.jellyfin();
    if (!client) return false;
    if (qcCache && Date.now() - qcCache.at < 60_000) return qcCache.enabled;
    const enabled = await client.quickConnectEnabled().catch(() => false);
    qcCache = { at: Date.now(), enabled };
    return enabled;
  };

  app.get('/setup/status', async () => ({
    needsSetup: users.count() === 0,
    setupCodeSource: ctx.config.setupToken ? 'env' : 'logs',
  }));

  app.post('/setup', LOGIN_LIMIT, async (req, reply) => {
    const body = parse(
      z.object({ setupCode: z.string().min(1).max(200), username: z.string().min(2).max(64), displayName: z.string().max(80).optional(), password: z.string().min(1).max(256) }),
      req.body,
    );
    checkSetupCode(body.setupCode);
    const id = await users.create({ username: body.username, displayName: body.displayName, password: body.password, role: 'admin' });
    ctx.log.info({ userId: id }, 'initial administrator created');
    const s = startSession(req, reply, id);
    return { ok: true, csrfToken: s.csrf };
  });

  /** Checks the server address during setup before asking for credentials. */
  app.post('/setup/jellyfin/check', LOGIN_LIMIT, async (req) => {
    const body = parse(z.object({ setupCode: z.string().min(1).max(200), url: ServerUrl }), req.body);
    checkSetupCode(body.setupCode);
    const client = ctx.integrations.jellyfinAt(body.url, null);
    try {
      const info = await client.publicInfo();
      const quick = await client.quickConnectEnabled().catch(() => false);
      return { serverName: info.ServerName ?? 'Jellyfin', version: info.Version ?? null, quickConnect: quick };
    } catch (err) {
      return setupFailure(err);
    }
  });

  app.post('/setup/jellyfin', LOGIN_LIMIT, async (req, reply) => {
    const body = parse(
      z.object({ setupCode: z.string().min(1).max(200), url: ServerUrl, username: z.string().min(1).max(128), password: z.string().max(256), allowAll: z.boolean().default(true) }),
      req.body,
    );
    checkSetupCode(body.setupCode);
    const client = ctx.integrations.jellyfinAt(body.url, null);
    let s: JellyfinSignIn;
    try {
      await client.publicInfo();
      s = await client.authenticateByName(body.username, body.password);
    } catch (err) {
      return setupFailure(err);
    }
    return completeJellyfinSetup(req, reply, client, body.url, s, body.allowAll);
  });

  app.post('/setup/jellyfin/quick-connect', QC_START_LIMIT, async (req) => {
    const body = parse(z.object({ setupCode: z.string().min(1).max(200), url: ServerUrl }), req.body);
    checkSetupCode(body.setupCode);
    const client = ctx.integrations.jellyfinAt(body.url, null);
    const deviceId = client.signInDeviceId(`setup-${randomToken(8)}`);
    try {
      const r = await client.quickConnectInitiate(deviceId);
      const p = quickConnect.add({ purpose: 'setup', url: body.url, secret: r.secret, code: r.code, deviceId, userId: null });
      return { id: p.id, code: r.code, expiresAt: new Date(p.expiresAt).toISOString(), interval: QUICK_CONNECT_POLL_MS / 1000 };
    } catch (err) {
      return setupFailure(err);
    }
  });

  app.post('/setup/jellyfin/quick-connect/poll', QC_POLL_LIMIT, async (req, reply) => {
    const body = parse(z.object({ setupCode: z.string().min(1).max(200), id: z.string().min(10).max(100), allowAll: z.boolean().default(true) }), req.body);
    checkSetupCode(body.setupCode);
    const p = quickConnect.get(body.id, 'setup');
    if (!p) return { status: 'expired' as const };
    const client = ctx.integrations.jellyfinAt(p.url, null);
    const state = await client.quickConnectState(p.secret, p.deviceId);
    if (state !== 'approved') {
      if (state === 'expired') quickConnect.delete(p.id);
      return { status: state };
    }
    quickConnect.delete(p.id);
    const s = await client.authenticateWithQuickConnect(p.secret, p.deviceId);
    return { status: 'authorized' as const, ...(await completeJellyfinSetup(req, reply, client, p.url, s, body.allowAll)) };
  });

  app.post('/auth/login', LOGIN_LIMIT, async (req, reply) => {
    const body = parse(z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) }), req.body);
    const row = users.byUsername(body.username);
    const ok = await verifyPassword(body.password, row?.password_hash ?? null);
    if (!row || !ok) {
      req.log.info({ username: body.username.slice(0, 64) }, 'failed login');
      throw new ApiError(401, 'invalid_credentials', 'The username or password is incorrect.');
    }
    if (row.disabled) throw new ApiError(403, 'disabled', 'This account is disabled. Contact an administrator.');
    const s = startSession(req, reply, row.id);
    return { ok: true, csrfToken: s.csrf };
  });

  app.post('/auth/jellyfin', LOGIN_LIMIT, async (req, reply) => {
    const body = parse(z.object({ username: z.string().min(1).max(128), password: z.string().max(256) }), req.body);
    const client = loginClient();
    let s: JellyfinSignIn;
    try {
      s = await client.authenticateByName(body.username, body.password);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'auth') throw new ApiError(401, 'invalid_credentials', 'Jellyfin rejected that username or password.');
      throw err;
    }
    await client.endSession(s);
    const row = await accountFor(s);
    const session = startSession(req, reply, row.id);
    return { ok: true, csrfToken: session.csrf };
  });

  // ---- Quick Connect sign-in ------------------------------------------------------------
  app.post('/auth/quick-connect', QC_START_LIMIT, async (req) => {
    const client = loginClient();
    const deviceId = client.signInDeviceId(`qc-${randomToken(8)}`);
    let r;
    try {
      r = await client.quickConnectInitiate(deviceId);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'forbidden') throw new ApiError(400, 'quick_connect_disabled', err.message);
      throw err;
    }
    const p = quickConnect.add({ purpose: 'login', url: client.baseUrl, secret: r.secret, code: r.code, deviceId, userId: null });
    return { id: p.id, code: r.code, expiresAt: new Date(p.expiresAt).toISOString(), interval: QUICK_CONNECT_POLL_MS / 1000 };
  });

  app.post('/auth/quick-connect/poll', QC_POLL_LIMIT, async (req, reply) => {
    const body = parse(z.object({ id: z.string().min(10).max(100) }), req.body);
    const client = loginClient();
    const p = quickConnect.get(body.id, 'login');
    if (!p) return { status: 'expired' as const };
    const state = await client.quickConnectState(p.secret, p.deviceId);
    if (state !== 'approved') {
      if (state === 'expired') quickConnect.delete(p.id);
      return { status: state };
    }
    quickConnect.delete(p.id);
    const s = await client.authenticateWithQuickConnect(p.secret, p.deviceId);
    await client.endSession(s);
    const row = await accountFor(s);
    const session = startSession(req, reply, row.id);
    return { status: 'authorized' as const, ok: true, csrfToken: session.csrf };
  });

  app.post('/auth/quick-connect/cancel', async (req) => {
    const body = parse(z.object({ id: z.string().min(10).max(100) }), req.body);
    if (quickConnect.get(body.id, 'login') || quickConnect.get(body.id, 'setup')) quickConnect.delete(body.id);
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.sessionId) sessions.destroy(req.sessionId);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const settings = ctx.settings.all();
    const jellyfinLogin = settings['auth.jellyfinLogin'] && ctx.integrations.isReady('jellyfin');
    const jfInfo = ctx.integrations.get('jellyfin').serverInfo;
    const base = {
      jellyfinLogin,
      jellyfin: jellyfinLogin
        ? { serverName: typeof jfInfo?.serverName === 'string' ? jfInfo.serverName : null, quickConnect: await quickConnectEnabled(), autoCreate: settings['auth.jellyfinAutoCreate'] }
        : null,
      needsSetup: users.count() === 0,
      version: ctx.config.version,
    };
    if (!req.user) return { user: null, ...base };
    const u = req.user;
    return {
      ...base,
      user: {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        role: u.role,
        authSource: u.authSource,
        hasPassword: u.hasPassword,
        jellyfin: u.jellyfinUserId ? { userId: u.jellyfinUserId, username: u.jellyfinUsername } : null,
        seerr: u.seerrUserId ? { userId: u.seerrUserId, username: u.seerrUsername } : null,
        preferences: u.preferences,
      },
      csrfToken: req.csrfToken,
      services: {
        jellyfin: ctx.integrations.isReady('jellyfin'),
        seerr: ctx.integrations.isReady('seerr'),
        tmdb: ctx.integrations.isReady('tmdb'),
        trakt: ctx.integrations.isReady('trakt'),
        metadata: ctx.metadata()?.name ?? null,
      },
      sources: SOURCE_DESCRIPTORS,
    };
  });

  app.put('/auth/password', LOGIN_LIMIT, async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ currentPassword: z.string().max(256).optional(), newPassword: z.string().min(1).max(256) }), req.body);
    const row = users.byUsername(u.username)!;
    if (row.password_hash) {
      if (!body.currentPassword || !(await verifyPassword(body.currentPassword, row.password_hash))) {
        throw new ApiError(400, 'invalid_credentials', 'Your current password is incorrect.');
      }
    }
    await users.setPassword(u.id, body.newPassword);
    const signedOut = sessions.destroyAllFor(u.id, req.sessionId ?? undefined);
    return { ok: true, signedOutSessions: signedOut };
  });

  app.get('/auth/sessions', async (req) => {
    const u = requireUser(req);
    return { sessions: sessions.list(u.id).map((s) => ({ ...s, id: s.id.slice(0, 12), current: s.id === req.sessionId })) };
  });

  app.post('/auth/sessions/revoke-others', async (req) => {
    const u = requireUser(req);
    return { revoked: sessions.destroyAllFor(u.id, req.sessionId ?? undefined) };
  });

  app.put('/me/preferences', async (req) => {
    const u = requireUser(req);
    const body = parse(
      z.object({ appearance: z.enum(['system', 'light', 'dark']).optional(), posterSize: z.enum(['small', 'medium', 'large']).optional() }),
      req.body,
    );
    users.setPreferences(u.id, { ...u.preferences, ...body });
    return { ok: true };
  });

  app.put('/me/profile', async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ displayName: z.string().trim().min(1).max(80) }), req.body);
    users.update(u.id, { displayName: body.displayName });
    return { ok: true };
  });
}
