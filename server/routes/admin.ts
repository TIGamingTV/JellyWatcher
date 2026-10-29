import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { nowIso } from '../db/index.js';
import { ApiError } from '../http/errors.js';
import { IdParam, parse } from '../http/validate.js';
import { requireAdmin, requireUser } from '../security/auth.js';
import { SettingsSchema } from '../services/settings.js';
import { triggerJob } from '../sync/scheduler.js';
import { syncSeerrUsers } from '../sync/seerr.js';
import { usernameFromJellyfin } from './auth.js';

export async function adminRoutes(app: FastifyInstance, { ctx, users, sessions }: AppDeps) {
  app.get('/admin/users', async (req) => {
    requireAdmin(req);
    return { users: users.list() };
  });

  app.post('/admin/users', async (req) => {
    requireAdmin(req);
    const body = parse(
      z.object({
        username: z.string().min(2).max(64),
        displayName: z.string().max(80).optional(),
        password: z.string().max(256).optional(),
        role: z.enum(['admin', 'user']).default('user'),
        authSource: z.enum(['local', 'jellyfin']).default('local'),
        jellyfinUserId: z.string().max(64).optional(),
      }),
      req.body,
    );
    let jellyfinUsername: string | null = null;
    if (body.jellyfinUserId) {
      const jf = ctx.integrations.jellyfin();
      const match = jf ? (await jf.users()).find((u) => u.Id === body.jellyfinUserId) : undefined;
      if (!match) throw new ApiError(400, 'unknown_jellyfin_user', 'That Jellyfin user was not found.');
      jellyfinUsername = match.Name;
      if (users.byJellyfinId(body.jellyfinUserId)) throw new ApiError(409, 'jellyfin_linked', 'That Jellyfin account is already linked to another user.');
    }
    if (body.authSource === 'jellyfin' && !body.jellyfinUserId) throw new ApiError(400, 'jellyfin_required', 'Choose the Jellyfin account this user signs in with.');
    const id = await users.create({ ...body, jellyfinUserId: body.jellyfinUserId ?? null, jellyfinUsername, password: body.password || null });
    void syncSeerrUsers(ctx).catch(() => undefined);
    return { id };
  });

  app.patch('/admin/users/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(IdParam, req.params);
    const body = parse(
      z.object({
        displayName: z.string().trim().min(1).max(80).optional(),
        role: z.enum(['admin', 'user']).optional(),
        disabled: z.boolean().optional(),
        jellyfinUserId: z.string().max(64).nullable().optional(),
        seerrUserId: z.number().int().positive().nullable().optional(),
        password: z.string().max(256).optional(),
      }),
      req.body,
    );
    if (id === admin.id && (body.disabled || body.role === 'user')) throw new ApiError(400, 'self_demote', 'You cannot disable or demote your own account.');
    const patch: Parameters<typeof users.update>[1] = { displayName: body.displayName, role: body.role, disabled: body.disabled };
    if (body.jellyfinUserId !== undefined) {
      if (body.jellyfinUserId === null) Object.assign(patch, { jellyfinUserId: null, jellyfinUsername: null });
      else {
        const jf = ctx.integrations.jellyfin();
        const match = jf ? (await jf.users()).find((u) => u.Id === body.jellyfinUserId) : undefined;
        if (!match) throw new ApiError(400, 'unknown_jellyfin_user', 'That Jellyfin user was not found.');
        Object.assign(patch, { jellyfinUserId: match.Id, jellyfinUsername: match.Name });
      }
    }
    if (body.seerrUserId !== undefined) {
      if (body.seerrUserId === null) Object.assign(patch, { seerrUserId: null, seerrUsername: null, seerrPermissions: null });
      else {
        const seerr = ctx.integrations.seerr();
        const match = seerr ? (await seerr.users()).find((u) => u.id === body.seerrUserId) : undefined;
        if (!match) throw new ApiError(400, 'unknown_seerr_user', 'That Seerr user was not found.');
        // Requests synced from Seerr are credited by Seerr user, so one Seerr user may be linked once.
        const holder = ctx.db.prepare('SELECT username FROM users WHERE seerr_user_id = ? AND id != ?').get(match.id, id) as { username: string } | undefined;
        if (holder) throw new ApiError(409, 'seerr_user_taken', `That Seerr user is already linked to ${holder.username}. Unlink it there first.`);
        Object.assign(patch, { seerrUserId: match.id, seerrUsername: match.displayName ?? match.username ?? null, seerrPermissions: match.permissions ?? null });
      }
    }
    users.update(id, patch);
    if (body.password) {
      await users.setPassword(id, body.password);
      sessions.destroyAllFor(id);
    }
    return { ok: true };
  });

  app.delete('/admin/users/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(IdParam, req.params);
    if (id === admin.id) throw new ApiError(400, 'self_delete', 'You cannot delete your own account.');
    users.remove(id);
    return { ok: true };
  });

  app.get('/admin/jellyfin-users', async (req) => {
    requireAdmin(req);
    const jf = ctx.integrations.jellyfin();
    if (!jf) throw new ApiError(400, 'jellyfin_not_configured', 'Connect Jellyfin first.');
    const list = await jf.users();
    return {
      users: list.map((u) => ({ id: u.Id, name: u.Name, isAdmin: u.Policy?.IsAdministrator ?? false, disabled: u.Policy?.IsDisabled ?? false, linked: Boolean(users.byJellyfinId(u.Id)) })),
    };
  });

  /** Creates member accounts for Jellyfin users (like Seerr's "Import Jellyfin Users"). */
  app.post('/admin/users/import-jellyfin', async (req) => {
    requireAdmin(req);
    const body = parse(z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500) }), req.body);
    const jf = ctx.integrations.jellyfin();
    if (!jf) throw new ApiError(400, 'jellyfin_not_configured', 'Connect Jellyfin first.');
    const all = new Map((await jf.users()).map((u) => [u.Id, u]));
    let created = 0;
    for (const id of new Set(body.ids)) {
      const j = all.get(id);
      if (!j || users.byJellyfinId(j.Id)) continue;
      let username = usernameFromJellyfin(j.Name, j.Id);
      if (users.byUsername(username)) username = `${username.slice(0, 60)}-jf`;
      if (users.byUsername(username)) continue;
      await users.create({ username, displayName: j.Name, role: 'user', authSource: 'jellyfin', jellyfinUserId: j.Id, jellyfinUsername: j.Name });
      created++;
    }
    if (created) {
      void syncSeerrUsers(ctx).catch(() => undefined);
      void triggerJob(ctx, 'jellyfin', 'event');
    }
    return { created };
  });

  app.get('/admin/seerr-users', async (req) => {
    requireAdmin(req);
    const seerr = ctx.integrations.seerr();
    if (!seerr) throw new ApiError(400, 'seerr_not_configured', 'Connect Seerr first.');
    const list = await seerr.users();
    return {
      users: list.map((u) => ({
        id: u.id,
        name: u.displayName ?? u.jellyfinUsername ?? u.username ?? `User ${u.id}`,
        jellyfinUserId: u.jellyfinUserId ?? null,
        permissions: u.permissions ?? null,
      })),
    };
  });

  app.post('/admin/users/auto-link-seerr', async (req) => {
    requireAdmin(req);
    return { linked: await syncSeerrUsers(ctx) };
  });

  app.get('/admin/settings', async (req) => {
    requireAdmin(req);
    return { settings: ctx.settings.all() };
  });

  app.put('/admin/settings', async (req) => {
    requireAdmin(req);
    const patch = parse(SettingsSchema.partial(), req.body);
    return { settings: ctx.settings.update(patch) };
  });

  // Sync status is visible to everyone (no secrets); triggering global jobs needs admin.
  app.get('/sync/status', async (req) => {
    requireUser(req);
    const jobs = (['seerr', 'jellyfin', 'lists', 'match', 'metadata'] as const).map((job) => {
      const last = ctx.jobs.lastRun(job);
      return { job, running: ctx.jobs.isRunning(job), last };
    });
    return { jobs, pendingMatches: ctx.matcher.pendingCount() };
  });

  app.post('/admin/sync/:job', async (req) => {
    requireAdmin(req);
    const { job } = parse(z.object({ job: z.enum(['seerr', 'jellyfin', 'lists', 'match', 'metadata']) }), req.params);
    if (job === 'lists') {
      // A manual "sync all lists" refreshes every auto-sync list regardless of its interval.
      ctx.db.prepare('UPDATE lists SET last_attempt_at = NULL WHERE auto_sync = 1 AND sync_supported = 1').run();
    }
    const p = triggerJob(ctx, job, 'manual');
    const result = await Promise.race([p, new Promise((r) => setTimeout(() => r(null), 1500))]);
    return { started: true, finished: result !== null, result };
  });

  app.get('/admin/sync/history', async (req) => {
    requireAdmin(req);
    const q = parse(z.object({ job: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    return { runs: ctx.jobs.history(q.limit, q.job) };
  });

  app.get('/admin/diagnostics', async (req) => {
    requireAdmin(req);
    const counts = Object.fromEntries(
      ['users', 'lists', 'list_items', 'titles', 'jellyfin_items', 'jellyfin_user_data', 'seerr_media', 'requests', 'sync_runs'].map((t) => [
        t,
        (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
      ]),
    );
    const dbSize = fs.existsSync(ctx.config.dbPath) ? fs.statSync(ctx.config.dbPath).size : 0;
    const migrations = ctx.db.prepare('SELECT name, applied_at AS appliedAt FROM schema_migrations ORDER BY name').all();
    return {
      version: ctx.config.version,
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      uptimeSeconds: Math.round(process.uptime()),
      dataDir: ctx.config.dataDir,
      dbSizeBytes: dbSize,
      counts,
      migrations,
      runningJobs: ctx.jobs.runningJobs(),
      integrations: (['jellyfin', 'seerr', 'tmdb', 'trakt'] as const).map((p) => {
        const v = ctx.integrations.view(p);
        return { provider: p, status: v.status, ready: v.ready, lastOkAt: v.lastOkAt, lastError: v.lastError };
      }),
      matchStatus: ctx.db.prepare('SELECT match_status AS status, COUNT(*) AS n FROM list_items GROUP BY match_status').all(),
    };
  });

  /** Streams a consistent online backup of the database. Secrets inside stay encrypted. */
  app.get('/admin/backup', async (req, reply) => {
    requireAdmin(req);
    const dir = path.join(ctx.config.dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const name = `jellywatcher-${nowIso().replace(/[:.]/g, '-')}.db`;
    const file = path.join(dir, name);
    await ctx.db.backup(file);
    // Keep the 10 newest manual backups.
    const old = fs.readdirSync(dir).filter((f) => f.startsWith('jellywatcher-') && f.endsWith('.db')).sort().reverse().slice(10);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
    reply.header('Content-Type', 'application/vnd.sqlite3');
    reply.header('Content-Disposition', `attachment; filename="${name}"`);
    return reply.send(fs.createReadStream(file));
  });
}
