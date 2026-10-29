import type { AppContext } from '../context.js';
import { ApiError } from '../http/errors.js';
import { triggerJob } from '../sync/scheduler.js';
import type { UserService } from './users.js';

/** Usernames in JellyWatcher allow fewer characters than Jellyfin's. */
export function usernameFromJellyfin(name: string, userId: string): string {
  const clean = name.replace(/[^A-Za-z0-9._@-]/g, '').slice(0, 60);
  return clean.length >= 2 ? clean : `jellyfin-${userId.slice(0, 8)}`;
}

export interface VerifiedJellyfinUser {
  userId: string;
  name: string;
  disabled?: boolean;
}

/**
 * Finds (or, when the administrator allows it, creates) the JellyWatcher account of a Jellyfin
 * user whose identity was verified by Jellyfin: a password or Quick Connect sign-in, or the
 * JellyWatcher plugin running inside Jellyfin.
 */
export async function accountForJellyfinUser(ctx: AppContext, users: UserService, verified: VerifiedJellyfinUser) {
  if (verified.disabled) throw new ApiError(403, 'disabled', 'This Jellyfin account is disabled.');
  let row = users.byJellyfinId(verified.userId);
  if (!row) {
    if (!ctx.settings.get('auth.jellyfinAutoCreate')) {
      throw new ApiError(403, 'not_invited', 'Your Jellyfin account has no JellyWatcher account yet. Ask an administrator to add you.');
    }
    let username = usernameFromJellyfin(verified.name, verified.userId);
    if (users.byUsername(username)) username = `${username.slice(0, 60)}-jf`;
    if (users.byUsername(username)) username = `jellyfin-${verified.userId.slice(0, 12)}`;
    const id = await users.create({ username, displayName: verified.name || username, role: 'user', authSource: 'jellyfin', jellyfinUserId: verified.userId, jellyfinUsername: verified.name || null });
    row = users.byJellyfinId(verified.userId)!;
    ctx.log.info({ userId: id }, 'account created from Jellyfin sign-in');
    void triggerJob(ctx, 'jellyfin', 'event');
  } else if (verified.name && row.jellyfin_username !== verified.name) {
    users.update(row.id, { jellyfinUsername: verified.name });
    row = users.byJellyfinId(verified.userId)!;
  }
  if (row.disabled) throw new ApiError(403, 'disabled', 'This account is disabled. Contact an administrator.');
  return row;
}
