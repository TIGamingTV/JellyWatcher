import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { ApiError, ProviderError } from '../http/errors.js';
import { parse } from '../http/validate.js';
import { clearSessionCookie, requireUser, setSessionCookie } from '../security/auth.js';
import { safeEqual } from '../security/crypto.js';
import { verifyPassword } from '../security/passwords.js';
import { SOURCE_DESCRIPTORS } from '../providers/types.js';

const LOGIN_LIMIT = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

export async function authRoutes(app: FastifyInstance, { ctx, users, sessions, setupCode }: AppDeps) {
  const startSession = (req: Parameters<typeof setSessionCookie>[1], reply: Parameters<typeof setSessionCookie>[0], userId: number) => {
    const s = sessions.create(userId, { userAgent: req.headers['user-agent'], ip: req.ip });
    setSessionCookie(reply, req, ctx, s.token, s.expiresAt);
    return s;
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
    if (users.count() > 0) throw new ApiError(409, 'already_setup', 'JellyWatcher is already set up. Sign in instead.');
    const expected = setupCode();
    if (!expected || !safeEqual(body.setupCode.trim(), expected)) {
      throw new ApiError(403, 'bad_setup_code', 'That setup code is not correct. Find it in the container logs (docker logs jellywatcher).');
    }
    const id = await users.create({ username: body.username, displayName: body.displayName, password: body.password, role: 'admin' });
    ctx.log.info({ userId: id }, 'initial administrator created');
    const s = startSession(req, reply, id);
    return { ok: true, csrfToken: s.csrf };
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
    if (!ctx.settings.get('auth.jellyfinLogin')) throw new ApiError(403, 'disabled', 'Signing in with Jellyfin is turned off.');
    const client = ctx.integrations.jellyfin();
    if (!client) throw new ApiError(503, 'jellyfin_unavailable', 'Jellyfin is not configured.');
    let verified;
    try {
      verified = await client.verifyCredentials(body.username, body.password);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'auth') throw new ApiError(401, 'invalid_credentials', 'Jellyfin rejected that username or password.');
      throw err;
    }
    let row = users.byJellyfinId(verified.userId);
    if (!row) {
      if (!ctx.settings.get('auth.jellyfinAutoCreate')) {
        throw new ApiError(403, 'not_invited', 'Your Jellyfin account has no JellyWatcher account yet. Ask an administrator to add you.');
      }
      let username = verified.name.replace(/[^A-Za-z0-9._@-]/g, '').slice(0, 60) || `jellyfin-${verified.userId.slice(0, 8)}`;
      if (users.byUsername(username)) username = `${username}-jf`;
      const id = await users.create({ username, displayName: verified.name, role: 'user', authSource: 'jellyfin', jellyfinUserId: verified.userId, jellyfinUsername: verified.name });
      row = users.byJellyfinId(verified.userId)!;
      ctx.log.info({ userId: id }, 'account created from Jellyfin sign-in');
    }
    if (row.disabled) throw new ApiError(403, 'disabled', 'This account is disabled. Contact an administrator.');
    const s = startSession(req, reply, row.id);
    return { ok: true, csrfToken: s.csrf };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.sessionId) sessions.destroy(req.sessionId);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const settings = ctx.settings.all();
    const base = {
      jellyfinLogin: settings['auth.jellyfinLogin'] && ctx.integrations.isReady('jellyfin'),
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
