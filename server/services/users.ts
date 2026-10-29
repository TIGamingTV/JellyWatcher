import { nowIso, type DB } from '../db/index.js';
import { ApiError } from '../http/errors.js';
import { toSessionUser, type SessionUser } from '../security/auth.js';
import { hashPassword, validatePasswordStrength } from '../security/passwords.js';

export const USERNAME_RE = /^[A-Za-z0-9._@-]{2,64}$/;

export class UserService {
  constructor(private readonly db: DB) {}

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  byUsername(username: string) {
    return this.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) as
      | (Parameters<typeof toSessionUser>[0] & { password_hash: string | null; disabled: number })
      | undefined;
  }

  byId(id: number): SessionUser | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Parameters<typeof toSessionUser>[0] | undefined;
    return row ? toSessionUser(row) : null;
  }

  /** Jellyfin writes user ids with or without dashes depending on the API; both forms match. */
  byJellyfinId(jellyfinUserId: string) {
    const compact = jellyfinUserId.replace(/-/g, '').toLowerCase();
    return this.db
      .prepare("SELECT * FROM users WHERE jellyfin_user_id = ? OR REPLACE(LOWER(jellyfin_user_id), '-', '') = ? ORDER BY jellyfin_user_id = ? DESC LIMIT 1")
      .get(jellyfinUserId, compact, jellyfinUserId) as
      | (Parameters<typeof toSessionUser>[0] & { disabled: number })
      | undefined;
  }

  async create(input: {
    username: string;
    displayName?: string;
    password?: string | null;
    role: 'admin' | 'user';
    authSource?: 'local' | 'jellyfin';
    jellyfinUserId?: string | null;
    jellyfinUsername?: string | null;
  }): Promise<number> {
    if (!USERNAME_RE.test(input.username)) throw new ApiError(400, 'invalid_username', 'Usernames use 2–64 letters, numbers, dots, dashes, underscores or @.');
    if (this.byUsername(input.username)) throw new ApiError(409, 'username_taken', 'That username is already in use.');
    let hash: string | null = null;
    if (input.password) {
      const weak = validatePasswordStrength(input.password);
      if (weak) throw new ApiError(400, 'weak_password', weak);
      hash = await hashPassword(input.password);
    } else if ((input.authSource ?? 'local') === 'local') {
      throw new ApiError(400, 'password_required', 'A password is required for local accounts.');
    }
    const now = nowIso();
    const res = this.db
      .prepare(
        `INSERT INTO users (username, display_name, password_hash, role, auth_source, jellyfin_user_id, jellyfin_username, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.username, input.displayName?.trim() || input.username, hash, input.role, input.authSource ?? 'local', input.jellyfinUserId ?? null, input.jellyfinUsername ?? null, now, now);
    return Number(res.lastInsertRowid);
  }

  list() {
    return this.db
      .prepare(
        `SELECT u.id, u.username, u.display_name AS displayName, u.role, u.auth_source AS authSource, u.jellyfin_user_id AS jellyfinUserId,
                u.jellyfin_username AS jellyfinUsername, u.seerr_user_id AS seerrUserId, u.seerr_username AS seerrUsername, u.disabled = 1 AS disabled,
                u.created_at AS createdAt, (SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS lastSeenAt,
                (SELECT COUNT(*) FROM lists l WHERE l.user_id = u.id) AS listCount
           FROM users u ORDER BY u.username COLLATE NOCASE`,
      )
      .all();
  }

  adminCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;
  }

  update(
    id: number,
    patch: {
      displayName?: string;
      role?: 'admin' | 'user';
      disabled?: boolean;
      jellyfinUserId?: string | null;
      jellyfinUsername?: string | null;
      seerrUserId?: number | null;
      seerrUsername?: string | null;
      seerrPermissions?: number | null;
    },
  ): void {
    const current = this.byId(id);
    if (!current) throw new ApiError(404, 'not_found', 'User not found.');
    const demoting = (patch.role && patch.role !== 'admin') || patch.disabled === true;
    if (current.role === 'admin' && demoting && this.adminCount() <= 1) {
      throw new ApiError(400, 'last_admin', 'At least one active administrator is required.');
    }
    if (patch.jellyfinUserId) {
      const other = this.byJellyfinId(patch.jellyfinUserId);
      if (other && other.id !== id) throw new ApiError(409, 'jellyfin_linked', 'That Jellyfin account is already linked to another JellyWatcher account.');
    }
    const sets: string[] = [];
    const vals: unknown[] = [];
    const map: Record<string, string> = {
      displayName: 'display_name',
      role: 'role',
      disabled: 'disabled',
      jellyfinUserId: 'jellyfin_user_id',
      jellyfinUsername: 'jellyfin_username',
      seerrUserId: 'seerr_user_id',
      seerrUsername: 'seerr_username',
      seerrPermissions: 'seerr_permissions',
    };
    for (const [k, col] of Object.entries(map)) {
      const v = (patch as Record<string, unknown>)[k];
      if (v === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    vals.push(nowIso(), id);
    this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    if (patch.disabled) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }

  async setPassword(id: number, password: string): Promise<void> {
    const weak = validatePasswordStrength(password);
    if (weak) throw new ApiError(400, 'weak_password', weak);
    this.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(await hashPassword(password), nowIso(), id);
  }

  setPreferences(id: number, prefs: Record<string, unknown>): void {
    this.db.prepare('UPDATE users SET preferences = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(prefs), nowIso(), id);
  }

  remove(id: number): void {
    const u = this.byId(id);
    if (!u) throw new ApiError(404, 'not_found', 'User not found.');
    if (u.role === 'admin' && this.adminCount() <= 1) throw new ApiError(400, 'last_admin', 'You cannot delete the last administrator.');
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }
}
