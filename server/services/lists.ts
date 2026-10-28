import { nowIso, parseJson, type DB } from '../db/index.js';
import { errorMessage } from '../http/errors.js';
import { scrub } from '../logger.js';
import type { ListFetchResult, SourceItem, SourceListInfo } from '../providers/types.js';

export interface ListRow {
  id: number;
  user_id: number;
  connection_id: number | null;
  provider: string;
  kind: string;
  external_id: string;
  source_ref: string;
  name: string;
  description: string | null;
  owner_name: string | null;
  url: string | null;
  auto_sync: number;
  sync_supported: number;
  last_synced_at: string | null;
  last_attempt_at: string | null;
  last_status: string | null;
  last_error: string | null;
  item_count: number;
  created_at: string;
}

export interface ApplyResult {
  added: number;
  removed: number;
  updated: number;
  total: number;
  skipped: number;
}

export class ListService {
  constructor(private readonly db: DB) {}

  get(id: number): ListRow | undefined {
    return this.db.prepare('SELECT * FROM lists WHERE id = ?').get(id) as ListRow | undefined;
  }

  /** Returns the list only if it belongs to the user. Use for every user-initiated access. */
  getOwned(id: number, userId: number): ListRow | undefined {
    return this.db.prepare('SELECT * FROM lists WHERE id = ? AND user_id = ?').get(id, userId) as ListRow | undefined;
  }

  forUser(userId: number): ListRow[] {
    return this.db.prepare('SELECT * FROM lists WHERE user_id = ? ORDER BY provider, kind = \'watchlist\' DESC, name COLLATE NOCASE').all(userId) as ListRow[];
  }

  ref<T extends Record<string, unknown>>(list: ListRow): T {
    return parseJson<T>(list.source_ref, {} as T);
  }

  upsert(
    userId: number,
    provider: string,
    info: SourceListInfo,
    opts: { connectionId?: number | null; autoSync?: boolean; syncSupported?: boolean; sourceRef?: Record<string, unknown> } = {},
  ): number {
    const now = nowIso();
    const existing = this.db
      .prepare('SELECT id FROM lists WHERE user_id = ? AND provider = ? AND external_id = ?')
      .get(userId, provider, info.externalId) as { id: number } | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE lists SET name = ?, kind = ?, description = ?, owner_name = ?, url = ?, connection_id = COALESCE(?, connection_id),
             source_ref = CASE WHEN ? IS NULL THEN source_ref ELSE ? END, updated_at = ? WHERE id = ?`,
        )
        .run(
          info.name,
          info.kind,
          info.description ?? null,
          info.ownerName ?? null,
          info.url ?? null,
          opts.connectionId ?? null,
          opts.sourceRef ? 1 : null,
          JSON.stringify(opts.sourceRef ?? {}),
          now,
          existing.id,
        );
      return existing.id;
    }
    const res = this.db
      .prepare(
        `INSERT INTO lists (user_id, connection_id, provider, kind, external_id, source_ref, name, description, owner_name, url, auto_sync, sync_supported, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        opts.connectionId ?? null,
        provider,
        info.kind,
        info.externalId,
        JSON.stringify(opts.sourceRef ?? {}),
        info.name,
        info.description ?? null,
        info.ownerName ?? null,
        info.url ?? null,
        opts.autoSync === false ? 0 : 1,
        opts.syncSupported === false ? 0 : 1,
        now,
        now,
      );
    return Number(res.lastInsertRowid);
  }

  /**
   * Replaces the list's contents with a complete fetch. Existing rows keep their match decision unless
   * the identifiers reported by the source changed. Rows that disappeared from the source are removed.
   * Idempotent: applying the same fetch twice changes nothing.
   */
  applyItems(listId: number, result: Pick<ListFetchResult, 'items' | 'skipped'>): ApplyResult {
    const stamp = nowIso();
    const seen = new Set<string>();
    let added = 0;
    let updated = 0;

    const select = this.db.prepare('SELECT id, tmdb_id, imdb_id, tvdb_id, media_type, source_title, source_year FROM list_items WHERE list_id = ? AND source_key = ?');
    const insert = this.db.prepare(
      `INSERT INTO list_items (list_id, source_key, media_type, source_title, source_year, tmdb_id, imdb_id, tvdb_id, source_url, position, listed_at, notes, rating, watched_at, match_status, first_seen_at, last_seen_at)
       VALUES (@listId, @sourceKey, @mediaType, @title, @year, @tmdbId, @imdbId, @tvdbId, @sourceUrl, @position, @listedAt, @notes, @rating, @watchedAt, 'pending', @stamp, @stamp)`,
    );
    const touch = this.db.prepare(
      'UPDATE list_items SET position = @position, listed_at = @listedAt, notes = @notes, rating = @rating, watched_at = @watchedAt, source_url = @sourceUrl, last_seen_at = @stamp WHERE id = @id',
    );
    const reset = this.db.prepare(
      `UPDATE list_items SET media_type = @mediaType, source_title = @title, source_year = @year, tmdb_id = @tmdbId, imdb_id = @imdbId, tvdb_id = @tvdbId,
         title_id = NULL, match_status = 'pending', match_method = NULL, match_confidence = NULL, match_candidates = NULL, match_attempts = 0 WHERE id = @id`,
    );

    const tx = this.db.transaction((items: SourceItem[]) => {
      for (const item of items) {
        if (seen.has(item.sourceKey)) continue;
        seen.add(item.sourceKey);
        const params = {
          listId,
          sourceKey: item.sourceKey,
          mediaType: item.mediaType,
          title: item.title,
          year: item.year,
          tmdbId: item.tmdbId ?? null,
          imdbId: item.imdbId ?? null,
          tvdbId: item.tvdbId ?? null,
          sourceUrl: item.sourceUrl ?? null,
          position: item.position ?? null,
          listedAt: item.listedAt ?? null,
          notes: item.notes ?? null,
          rating: item.rating ?? null,
          watchedAt: item.watchedAt ?? null,
          stamp,
        };
        const row = select.get(listId, item.sourceKey) as
          | { id: number; tmdb_id: number | null; imdb_id: string | null; tvdb_id: number | null; media_type: string | null; source_title: string; source_year: number | null }
          | undefined;
        if (!row) {
          insert.run(params);
          added++;
          continue;
        }
        touch.run({ ...params, id: row.id });
        const identityChanged =
          row.tmdb_id !== params.tmdbId || row.imdb_id !== params.imdbId || row.media_type !== params.mediaType || row.source_title !== params.title || row.source_year !== params.year;
        if (identityChanged) {
          reset.run({ ...params, id: row.id });
          updated++;
        }
      }
      // Remove entries that are not in this (complete) fetch. Keyed on the seen set rather than on
      // timestamps so two applies within the same millisecond behave correctly.
      const removed = this.db
        .prepare('DELETE FROM list_items WHERE list_id = ? AND source_key NOT IN (SELECT value FROM json_each(?))')
        .run(listId, JSON.stringify([...seen])).changes;
      const total = (this.db.prepare('SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?').get(listId) as { n: number }).n;
      this.db
        .prepare("UPDATE lists SET item_count = ?, last_synced_at = ?, last_attempt_at = ?, last_status = 'ok', last_error = NULL, updated_at = ? WHERE id = ?")
        .run(total, stamp, stamp, stamp, listId);
      return { removed, total };
    });
    const { removed, total } = tx(result.items);
    return { added, removed, updated, total, skipped: result.skipped };
  }

  markAttempt(listId: number): void {
    this.db.prepare("UPDATE lists SET last_attempt_at = ?, last_status = 'running' WHERE id = ?").run(nowIso(), listId);
  }

  markError(listId: number, err: unknown): void {
    this.db.prepare("UPDATE lists SET last_attempt_at = ?, last_status = 'error', last_error = ? WHERE id = ?").run(nowIso(), scrub(errorMessage(err)).slice(0, 500), listId);
  }

  setAutoSync(listId: number, enabled: boolean): void {
    this.db.prepare('UPDATE lists SET auto_sync = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, nowIso(), listId);
  }

  rename(listId: number, name: string): void {
    this.db.prepare('UPDATE lists SET name = ?, updated_at = ? WHERE id = ?').run(name, nowIso(), listId);
  }

  remove(listId: number): void {
    this.db.prepare('DELETE FROM lists WHERE id = ?').run(listId);
  }

  /** Lists due for an automatic refresh. */
  due(intervalMinutes: number): ListRow[] {
    const cutoff = new Date(Date.now() - intervalMinutes * 60_000).toISOString();
    return this.db
      .prepare('SELECT * FROM lists WHERE auto_sync = 1 AND sync_supported = 1 AND (last_attempt_at IS NULL OR last_attempt_at < ?) ORDER BY last_attempt_at ASC NULLS FIRST LIMIT 50')
      .all(cutoff) as ListRow[];
  }
}
