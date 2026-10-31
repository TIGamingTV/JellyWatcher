import { randomUUID } from 'node:crypto';
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
  display: ListDisplay;
  /** Shown in Jellyfin through the plugin, as a collection or a private playlist. */
  jellyfin_mirror: JellyfinMirror | null;
  created_at: string;
}

export type ListDisplay = 'auto' | 'grid' | 'timeline';
export type JellyfinMirror = 'collection' | 'playlist';

/** Whether a list is shown as a timeline. The timeline is the standard view; the grid is opt-in. */
export function isTimeline(list: Pick<ListRow, 'display'>): boolean {
  return list.display !== 'grid';
}

/** Lists created in JellyWatcher (new or duplicated): edited here, never synced. */
export const LOCAL_PROVIDER = 'local';

export interface LocalItemInput {
  titleId: number;
  mediaType: 'movie' | 'tv';
  title: string;
  year: number | null;
  tmdbId: number;
  season?: number | null;
  episode?: number | null;
  episodeTitle?: string | null;
}

export function localSourceKey(i: Pick<LocalItemInput, 'mediaType' | 'tmdbId' | 'season' | 'episode'>): string {
  const part = i.season != null ? (i.episode != null ? `:s${i.season}e${i.episode}` : `:s${i.season}`) : '';
  return `tmdb:${i.mediaType}:${i.tmdbId}${part}`;
}

const ITEM_COLUMNS = `source_key, title_id, media_type, source_title, source_year, tmdb_id, imdb_id, tvdb_id, source_url, listed_at, notes, rating, watched_at,
  match_status, match_method, match_confidence, match_candidates, match_attempts, season_number, episode_number, episode_title, source_runtime, source_episodes, source_seasons`;
/** Effective order of a list's entries: the person's own order first, then the source's order. */
export const ITEM_ORDER = 'COALESCE(custom_position, 1000000 + COALESCE(position, 1000000)), id';

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
    return this.db.prepare("SELECT * FROM lists WHERE user_id = ? ORDER BY provider = 'local' DESC, provider, kind = 'watchlist' DESC, name COLLATE NOCASE").all(userId) as ListRow[];
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
      `INSERT INTO list_items (list_id, source_key, media_type, source_title, source_year, tmdb_id, imdb_id, tvdb_id, source_url, position, listed_at, notes, rating, watched_at,
         season_number, episode_number, episode_title, source_runtime, source_episodes, source_seasons, match_status, first_seen_at, last_seen_at)
       VALUES (@listId, @sourceKey, @mediaType, @title, @year, @tmdbId, @imdbId, @tvdbId, @sourceUrl, @position, @listedAt, @notes, @rating, @watchedAt,
         @season, @episode, @episodeTitle, @runtime, @episodes, @seasons, 'pending', @stamp, @stamp)`,
    );
    const touch = this.db.prepare(
      `UPDATE list_items SET position = @position, listed_at = @listedAt, notes = @notes, rating = @rating, watched_at = @watchedAt, source_url = @sourceUrl,
         season_number = @season, episode_number = @episode, episode_title = @episodeTitle, source_runtime = @runtime, source_episodes = @episodes, source_seasons = @seasons,
         last_seen_at = @stamp WHERE id = @id`,
    );
    const reset = this.db.prepare(
      `UPDATE list_items SET media_type = @mediaType, source_title = @title, source_year = @year, tmdb_id = @tmdbId, imdb_id = @imdbId, tvdb_id = @tvdbId,
         title_id = NULL, match_status = 'pending', match_method = NULL, match_confidence = NULL, match_candidates = NULL, match_attempts = 0 WHERE id = @id`,
    );

    const tx = this.db.transaction((items: SourceItem[]) => {
      for (const item of items) {
        // Episodes whose show was not looked up cannot be placed; never save them half-known.
        if (item.episodeImdbId || seen.has(item.sourceKey)) continue;
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
          season: item.seasonNumber ?? null,
          episode: item.seasonNumber != null ? (item.episodeNumber ?? null) : null,
          episodeTitle: item.episodeTitle ?? null,
          runtime: item.runtime ?? null,
          episodes: item.episodes ?? null,
          seasons: item.seasons ?? null,
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

  setDisplay(listId: number, display: ListDisplay): void {
    this.db.prepare('UPDATE lists SET display = ?, updated_at = ? WHERE id = ?').run(display, nowIso(), listId);
  }

  /** Turns the Jellyfin collection/playlist on, switches its kind, or turns it off. The plugin's last report is dropped. */
  setMirror(listId: number, mode: JellyfinMirror | null): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE lists SET jellyfin_mirror = ?, updated_at = ? WHERE id = ?').run(mode, nowIso(), listId);
      this.db.prepare('DELETE FROM list_mirrors WHERE list_id = ?').run(listId);
    })();
  }

  rename(listId: number, name: string): void {
    this.db.prepare('UPDATE lists SET name = ?, updated_at = ? WHERE id = ?').run(name, nowIso(), listId);
  }

  setDescription(listId: number, description: string | null): void {
    this.db.prepare('UPDATE lists SET description = ?, updated_at = ? WHERE id = ?').run(description, nowIso(), listId);
  }

  remove(listId: number): void {
    this.db.prepare('DELETE FROM lists WHERE id = ?').run(listId);
  }

  /** A new, empty list that lives only in JellyWatcher. */
  createLocal(userId: number, name: string, description: string | null = null, display: ListDisplay = 'timeline'): number {
    const now = nowIso();
    const res = this.db
      .prepare(
        `INSERT INTO lists (user_id, provider, kind, external_id, source_ref, name, description, auto_sync, sync_supported, display, last_synced_at, last_status, created_at, updated_at)
         VALUES (?, ?, 'local', ?, '{}', ?, ?, 0, 0, ?, ?, 'ok', ?, ?)`,
      )
      .run(userId, LOCAL_PROVIDER, `local:${randomUUID()}`, name, description, display, now, now, now);
    return Number(res.lastInsertRowid);
  }

  /**
   * Copies a list into a new local list in its current (possibly personal) order, keeping every
   * entry's match so nothing needs reviewing again.
   */
  duplicate(listId: number, userId: number, name: string): number {
    const src = this.getOwned(listId, userId);
    if (!src) throw new Error('list not found');
    return this.db.transaction(() => {
      const id = this.createLocal(userId, name, src.description, src.display);
      const stamp = nowIso();
      this.db
        .prepare(
          `INSERT INTO list_items (list_id, position, first_seen_at, last_seen_at, ${ITEM_COLUMNS})
           SELECT ?, ROW_NUMBER() OVER (ORDER BY ${ITEM_ORDER}), ?, ?, ${ITEM_COLUMNS} FROM list_items WHERE list_id = ?`,
        )
        .run(id, stamp, stamp, listId);
      this.refreshCount(id);
      return id;
    })();
  }

  refreshCount(listId: number): number {
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?').get(listId) as { n: number }).n;
    this.db.prepare('UPDATE lists SET item_count = ?, updated_at = ? WHERE id = ?').run(n, nowIso(), listId);
    return n;
  }

  /** Adds a matched title (or one season / episode of a show) to the end of a local list. */
  addLocalItem(listId: number, item: LocalItemInput): number {
    const key = localSourceKey(item);
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM list_items WHERE list_id = ? AND source_key = ?').get(listId, key)) return -1;
      const max = this.db.prepare('SELECT MAX(position) AS p, MAX(custom_position) AS c FROM list_items WHERE list_id = ?').get(listId) as { p: number | null; c: number | null };
      const stamp = nowIso();
      const res = this.db
        .prepare(
          `INSERT INTO list_items (list_id, source_key, title_id, media_type, source_title, source_year, tmdb_id, position, custom_position, listed_at,
             season_number, episode_number, episode_title, match_status, match_method, match_confidence, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'matched', 'manual', 1, ?, ?)`,
        )
        .run(
          listId,
          key,
          item.titleId,
          item.mediaType,
          item.title,
          item.year,
          item.tmdbId,
          (max.p ?? 0) + 1,
          max.c !== null ? max.c + 1 : null,
          stamp,
          item.season ?? null,
          item.season != null ? (item.episode ?? null) : null,
          item.episodeTitle ?? null,
          stamp,
          stamp,
        );
      this.refreshCount(listId);
      return Number(res.lastInsertRowid);
    })();
  }

  removeItem(listId: number, itemId: number): boolean {
    const n = this.db.prepare('DELETE FROM list_items WHERE id = ? AND list_id = ?').run(itemId, listId).changes;
    if (n) this.refreshCount(listId);
    return n > 0;
  }

  /**
   * Saves the person's order. `itemIds` is the full order; entries left out (hidden or added
   * meanwhile) follow afterwards in source order. Survives later syncs.
   */
  setOrder(listId: number, itemIds: number[]): number {
    const own = new Set((this.db.prepare('SELECT id FROM list_items WHERE list_id = ?').all(listId) as { id: number }[]).map((r) => r.id));
    const ids = [...new Set(itemIds)].filter((id) => own.has(id));
    this.db.transaction(() => {
      this.db.prepare('UPDATE list_items SET custom_position = NULL WHERE list_id = ?').run(listId);
      const set = this.db.prepare('UPDATE list_items SET custom_position = ? WHERE id = ?');
      ids.forEach((id, i) => set.run(i + 1, id));
      this.db.prepare('UPDATE lists SET updated_at = ? WHERE id = ?').run(nowIso(), listId);
    })();
    return ids.length;
  }

  /** Moves an entry to just after another one, keeping the rest of the effective order. */
  placeAfter(listId: number, itemId: number, afterItemId: number): void {
    const ids = (this.db.prepare(`SELECT id FROM list_items WHERE list_id = ? ORDER BY ${ITEM_ORDER}`).all(listId) as { id: number }[]).map((r) => r.id).filter((id) => id !== itemId);
    const at = ids.indexOf(afterItemId);
    if (at < 0) return;
    ids.splice(at + 1, 0, itemId);
    this.setOrder(listId, ids);
  }

  resetOrder(listId: number): void {
    this.db.prepare('UPDATE list_items SET custom_position = NULL WHERE list_id = ?').run(listId);
  }

  hasCustomOrder(listId: number): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM list_items WHERE list_id = ? AND custom_position IS NOT NULL LIMIT 1').get(listId));
  }

  /** Lists due for an automatic refresh. */
  due(intervalMinutes: number): ListRow[] {
    const cutoff = new Date(Date.now() - intervalMinutes * 60_000).toISOString();
    return this.db
      .prepare('SELECT * FROM lists WHERE auto_sync = 1 AND sync_supported = 1 AND (last_attempt_at IS NULL OR last_attempt_at < ?) ORDER BY last_attempt_at ASC NULLS FIRST LIMIT 50')
      .all(cutoff) as ListRow[];
  }
}
