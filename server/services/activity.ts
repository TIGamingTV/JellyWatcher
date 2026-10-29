import { nowIso, type DB } from '../db/index.js';

export type ActivityKind =
  | 'list_imported'
  | 'list_created'
  | 'list_synced'
  | 'marked_watched'
  | 'request_submitted'
  | 'request_approved'
  | 'request_declined'
  | 'request_failed'
  | 'request_available'
  | 'now_available'
  | 'connection_error';

export class ActivityService {
  constructor(private readonly db: DB) {}

  add(userId: number | null, kind: ActivityKind, message: string, titleId: number | null = null): void {
    this.db.prepare('INSERT INTO activity (user_id, kind, title_id, message, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, kind, titleId, message, nowIso());
  }

  /** Avoids repeating the same notice for the same title within a window. */
  addOnce(userId: number | null, kind: ActivityKind, message: string, titleId: number | null, withinHours = 24 * 30): void {
    const since = new Date(Date.now() - withinHours * 3600_000).toISOString();
    const exists = this.db
      .prepare('SELECT 1 FROM activity WHERE user_id IS ? AND kind = ? AND title_id IS ? AND created_at > ? LIMIT 1')
      .get(userId, kind, titleId, since);
    if (!exists) this.add(userId, kind, message, titleId);
  }

  recent(userId: number, limit = 30) {
    return this.db
      .prepare(
        `SELECT a.id, a.kind, a.message, a.created_at AS createdAt, a.title_id AS titleId, t.title, t.media_type AS mediaType, t.poster_path AS posterPath
           FROM activity a LEFT JOIN titles t ON t.id = a.title_id
          WHERE a.user_id = ? OR a.user_id IS NULL
          ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
      )
      .all(userId, limit);
  }

  prune(olderThanDays = 180): void {
    this.db.prepare('DELETE FROM activity WHERE created_at < ?').run(new Date(Date.now() - olderThanDays * 86400_000).toISOString());
  }
}
