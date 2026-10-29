import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { nowIso, parseJson } from '../db/index.js';
import { ApiError } from '../http/errors.js';
import { randomToken, safeEqual, sha256 } from './crypto.js';

export const SESSION_COOKIE = 'jw_session';

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: 'admin' | 'user';
  authSource: 'local' | 'jellyfin';
  jellyfinUserId: string | null;
  jellyfinUsername: string | null;
  seerrUserId: number | null;
  seerrUsername: string | null;
  seerrPermissions: number | null;
  preferences: Record<string, unknown>;
  hasPassword: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    sessionId: string | null;
    csrfToken: string | null;
  }
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  role: 'admin' | 'user';
  auth_source: 'local' | 'jellyfin';
  jellyfin_user_id: string | null;
  jellyfin_username: string | null;
  seerr_user_id: number | null;
  seerr_username: string | null;
  seerr_permissions: number | null;
  preferences: string;
  password_hash: string | null;
  disabled: number;
}

export function toSessionUser(r: UserRow): SessionUser {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    authSource: r.auth_source,
    jellyfinUserId: r.jellyfin_user_id,
    jellyfinUsername: r.jellyfin_username,
    seerrUserId: r.seerr_user_id,
    seerrUsername: r.seerr_username,
    seerrPermissions: r.seerr_permissions,
    preferences: parseJson(r.preferences, {}),
    hasPassword: Boolean(r.password_hash),
  };
}

export class SessionService {
  constructor(
    private readonly ctx: AppContext,
    private readonly ttlDays: number,
  ) {}

  create(userId: number, meta: { userAgent?: string; ip?: string }): { token: string; csrf: string; expiresAt: Date } {
    const token = randomToken(32);
    const csrf = randomToken(24);
    const expiresAt = new Date(Date.now() + this.ttlDays * 86400_000);
    const now = nowIso();
    this.ctx.db
      .prepare('INSERT INTO sessions (id, user_id, csrf_token, created_at, expires_at, last_seen_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sha256(token), userId, csrf, now, expiresAt.toISOString(), now, meta.userAgent?.slice(0, 200) ?? null, meta.ip ?? null);
    return { token, csrf, expiresAt };
  }

  lookup(token: string): { sessionId: string; csrf: string; user: SessionUser } | null {
    const id = sha256(token);
    const row = this.ctx.db
      .prepare(
        `SELECT s.id AS sid, s.csrf_token, s.expires_at, s.last_seen_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
      )
      .get(id) as (UserRow & { sid: string; csrf_token: string; expires_at: string; last_seen_at: string }) | undefined;
    if (!row) return null;
    if (Date.parse(row.expires_at) < Date.now() || row.disabled) {
      this.ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return null;
    }
    // Sliding expiry, written at most once per hour.
    if (Date.now() - Date.parse(row.last_seen_at) > 3600_000) {
      this.ctx.db
        .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
        .run(nowIso(), new Date(Date.now() + this.ttlDays * 86400_000).toISOString(), id);
    }
    return { sessionId: row.sid, csrf: row.csrf_token, user: toSessionUser(row) };
  }

  destroy(sessionId: string): void {
    this.ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  destroyAllFor(userId: number, exceptSessionId?: string): number {
    return this.ctx.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?').run(userId, exceptSessionId ?? null).changes;
  }

  list(userId: number) {
    return this.ctx.db
      .prepare('SELECT id, created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt, user_agent AS userAgent, ip FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC')
      .all(userId) as { id: string; createdAt: string; lastSeenAt: string; expiresAt: string; userAgent: string | null; ip: string | null }[];
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Endpoints that are called before a session exists or by other servers; protected by other means. */
const CSRF_EXEMPT = [/^\/api\/auth\/login$/, /^\/api\/auth\/jellyfin$/, /^\/api\/auth\/quick-connect(\/(poll|cancel))?$/, /^\/api\/setup(\/[a-z/-]+)?$/, /^\/api\/webhooks\//];

export function registerAuth(app: FastifyInstance, ctx: AppContext, sessions: SessionService): void {
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('csrfToken', null);

  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const s = sessions.lookup(token);
    if (!s) return;
    req.user = s.user;
    req.sessionId = s.sessionId;
    req.csrfToken = s.csrf;
  });

  app.addHook('preHandler', async (req) => {
    if (SAFE_METHODS.has(req.method) || !req.url.startsWith('/api/')) return;
    const path = req.url.split('?')[0]!;
    if (path.startsWith('/api/webhooks/')) return;
    // Cross-site request check: an Origin header, when sent, must match this server.
    const origin = req.headers.origin;
    if (origin && !originAllowed(origin, req, ctx)) throw new ApiError(403, 'bad_origin', 'Cross-site request blocked.');
    if (CSRF_EXEMPT.some((re) => re.test(path))) return;
    if (!req.user) return; // route-level auth will reject
    const header = req.headers['x-csrf-token'];
    if (typeof header !== 'string' || !req.csrfToken || !safeEqual(header, req.csrfToken)) {
      throw new ApiError(403, 'csrf', 'Your session token is missing or outdated. Reload the page and try again.');
    }
  });
}

function originAllowed(origin: string, req: FastifyRequest, ctx: AppContext): boolean {
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (ctx.config.publicUrl && o.origin === ctx.config.publicUrl.origin) return true;
  const host = (ctx.config.trustProxy && typeof req.headers['x-forwarded-host'] === 'string' ? req.headers['x-forwarded-host'].split(',')[0]!.trim() : req.headers.host) ?? '';
  return o.host === host;
}

export function setSessionCookie(reply: FastifyReply, req: FastifyRequest, ctx: AppContext, token: string, expiresAt: Date): void {
  const secure = ctx.config.cookieSecure === 'auto' ? req.protocol === 'https' : ctx.config.cookieSecure;
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', expires: expiresAt });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
  return req.user;
}

export function requireAdmin(req: FastifyRequest): SessionUser {
  const u = requireUser(req);
  if (u.role !== 'admin') throw new ApiError(403, 'forbidden', 'Only administrators can do this.');
  return u;
}
