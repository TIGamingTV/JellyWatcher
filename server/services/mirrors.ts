import { z } from 'zod';
import type { AppContext } from '../context.js';
import { nowIso } from '../db/index.js';
import { toSessionUser } from '../security/auth.js';
import { buildTimelines, type EntryKind, type TimelineEntry } from './timeline.js';
import type { JellyfinMirror, ListRow } from './lists.js';

/**
 * Lists shown in Jellyfin as a collection or a private playlist. JellyWatcher says what each one
 * should contain; the Jellyfin plugin fetches that, makes Jellyfin match it, and reports back.
 * JellyWatcher never calls the plugin.
 */

export interface MirrorEntry {
  kind: EntryKind;
  mediaType: 'movie' | 'tv';
  season: number | null;
  episode: number | null;
  /** The Jellyfin item JellyWatcher last saw for this entry (the episode for episode entries). */
  jellyfinItemId: string | null;
  /** Every Jellyfin movie/series item of the title JellyWatcher knows of. */
  jellyfinIds: string[];
  tmdbId: string | null;
  tvdbId: string | null;
  imdbId: string | null;
}

export interface MirrorList {
  listId: number;
  mode: JellyfinMirror;
  name: string;
  description: string | null;
  /** Jellyfin user id of the list owner (32 hex characters). */
  owner: string;
  entries: MirrorEntry[];
}

export interface MirrorPayload {
  /** Identifies this JellyWatcher; the plugin only touches collections and playlists it made for it. */
  instanceId: string;
  lists: MirrorList[];
}

interface OwnerRow {
  id: number;
  jellyfin_user_id: string;
}

const chunked = <T>(ids: number[], fn: (c: number[], ph: string) => T[]): T[] => {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const c = ids.slice(i, i + 500);
    out.push(...fn(c, c.map(() => '?').join(',')));
  }
  return out;
};

const compactId = (id: string) => id.replace(/-/g, '').toLowerCase();

/**
 * Everything the plugin should show in Jellyfin: every mirrored list of every enabled person with a
 * Jellyfin account, in the list's order. All matched entries are included (the plugin decides what
 * is in the library, so new titles show up without waiting for JellyWatcher's library sync), except
 * those marked "Not Watching".
 */
export function mirrorPayload(ctx: AppContext): MirrorPayload {
  const owners = ctx.db
    .prepare(
      `SELECT DISTINCT u.* FROM users u JOIN lists l ON l.user_id = u.id
        WHERE l.jellyfin_mirror IS NOT NULL AND u.disabled = 0 AND u.jellyfin_user_id IS NOT NULL ORDER BY u.id`,
    )
    .all() as (Parameters<typeof toSessionUser>[0] & OwnerRow)[];

  const lists: MirrorList[] = [];
  for (const owner of owners) {
    const rows = ctx.db.prepare('SELECT * FROM lists WHERE user_id = ? AND jellyfin_mirror IS NOT NULL ORDER BY id').all(owner.id) as ListRow[];
    const timelines = buildTimelines(ctx, toSessionUser(owner), rows);
    const entriesByList = new Map<number, { titleId: number; e: TimelineEntry }[]>();
    const titleIds = new Set<number>();
    for (const l of rows) {
      // Headers only title the parts below them; the parts are mirrored in their own places.
      const picked = (timelines.get(l.id)?.entries ?? []).filter((e) => e.matched && e.title && !e.skipped && !e.header).map((e) => ({ titleId: e.title!.id, e }));
      for (const p of picked) titleIds.add(p.titleId);
      entriesByList.set(l.id, picked);
    }
    const ids = [...titleIds];
    const titles = new Map(
      chunked(ids, (c, ph) =>
        ctx.db.prepare(`SELECT id, media_type, tmdb_id, tvdb_id, imdb_id FROM titles WHERE id IN (${ph})`).all(...c) as {
          id: number;
          media_type: 'movie' | 'tv';
          tmdb_id: number | null;
          tvdb_id: number | null;
          imdb_id: string | null;
        }[],
      ).map((t) => [t.id, t]),
    );
    const jfItems = new Map<number, string[]>();
    for (const r of chunked(ids, (c, ph) => ctx.db.prepare(`SELECT title_id, id FROM jellyfin_items WHERE title_id IN (${ph}) ORDER BY id`).all(...c) as { title_id: number; id: string }[])) {
      jfItems.set(r.title_id, [...(jfItems.get(r.title_id) ?? []), r.id]);
    }

    for (const l of rows) {
      const entries: MirrorEntry[] = [];
      for (const { titleId, e } of entriesByList.get(l.id) ?? []) {
        const t = titles.get(titleId);
        if (!t) continue;
        // Extra episodes of multi-episode files carry made-up ids ("<id>#2"); the plugin finds those by number.
        const itemId = e.jellyfinItemId && !e.jellyfinItemId.includes('#') ? e.jellyfinItemId : null;
        entries.push({
          kind: e.kind,
          mediaType: t.media_type,
          season: e.season,
          episode: e.episode,
          jellyfinItemId: itemId,
          jellyfinIds: jfItems.get(titleId) ?? [],
          tmdbId: t.tmdb_id !== null ? String(t.tmdb_id) : null,
          tvdbId: t.tvdb_id !== null ? String(t.tvdb_id) : null,
          imdbId: t.imdb_id,
        });
      }
      lists.push({ listId: l.id, mode: l.jellyfin_mirror!, name: l.name, description: l.description, owner: compactId(owner.jellyfin_user_id), entries });
    }
  }
  return { instanceId: ctx.settings.instanceId(), lists };
}

export const MirrorReportSchema = z.object({
  results: z
    .array(
      z.object({
        listId: z.number().int().positive(),
        mode: z.enum(['collection', 'playlist']),
        jellyfinId: z
          .string()
          .regex(/^[A-Fa-f0-9-]{32,36}$/)
          .nullable(),
        applied: z.number().int().min(0).max(1_000_000),
        missing: z.number().int().min(0).max(1_000_000),
        error: z.string().max(500).nullable(),
      }),
    )
    .max(10_000),
});

/** Saves what the plugin did. Reports for lists that are gone or were switched meanwhile are ignored. */
export function recordMirrorReports(ctx: AppContext, results: z.infer<typeof MirrorReportSchema>['results']): number {
  const now = nowIso();
  const upsert = ctx.db.prepare(
    `INSERT INTO list_mirrors (list_id, mode, jellyfin_id, applied, missing, last_error, synced_at)
     SELECT id, ?, ?, ?, ?, ?, ? FROM lists WHERE id = ? AND jellyfin_mirror = ?
     ON CONFLICT(list_id) DO UPDATE SET mode = excluded.mode, jellyfin_id = excluded.jellyfin_id, applied = excluded.applied,
       missing = excluded.missing, last_error = excluded.last_error, synced_at = excluded.synced_at`,
  );
  let saved = 0;
  ctx.db.transaction(() => {
    for (const r of results) {
      saved += upsert.run(r.mode, r.jellyfinId ? compactId(r.jellyfinId) : null, r.applied, r.missing, r.error, now, r.listId, r.mode).changes;
    }
  })();
  return saved;
}

export interface MirrorView {
  mode: JellyfinMirror;
  /** False until the plugin has applied the current mode. */
  synced: boolean;
  jellyfinId: string | null;
  applied: number;
  missing: number;
  error: string | null;
  syncedAt: string | null;
}

export function mirrorView(ctx: AppContext, l: Pick<ListRow, 'id' | 'jellyfin_mirror'>): MirrorView | null {
  if (!l.jellyfin_mirror) return null;
  const r = ctx.db.prepare('SELECT * FROM list_mirrors WHERE list_id = ? AND mode = ?').get(l.id, l.jellyfin_mirror) as
    | { jellyfin_id: string | null; applied: number; missing: number; last_error: string | null; synced_at: string }
    | undefined;
  return {
    mode: l.jellyfin_mirror,
    synced: Boolean(r),
    jellyfinId: r?.jellyfin_id ?? null,
    applied: r?.applied ?? 0,
    missing: r?.missing ?? 0,
    error: r?.last_error ?? null,
    syncedAt: r?.synced_at ?? null,
  };
}
