import { nowIso, parseJson, type DB } from '../db/index.js';
import type { MediaType } from '../domain/matching.js';
import type { TitleMetadata } from '../providers/tmdb.js';

export interface TitleRow {
  id: number;
  media_type: MediaType;
  tmdb_id: number | null;
  imdb_id: string | null;
  tvdb_id: number | null;
  title: string;
  original_title: string | null;
  year: number | null;
  release_date: string | null;
  overview: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  genres: string;
  runtime: number | null;
  episode_count: number | null;
  season_count: number | null;
  /** JSON [{ season, episodes }] for regular seasons. */
  seasons: string | null;
  metadata_source: string | null;
  metadata_updated_at: string | null;
}

export interface TitleSeed {
  mediaType: MediaType;
  tmdbId?: number | null;
  imdbId?: string | null;
  tvdbId?: number | null;
  title: string;
  year?: number | null;
  overview?: string | null;
  posterPath?: string | null;
  genres?: string[];
  source?: string;
}

export class TitleService {
  constructor(private readonly db: DB) {}

  get(id: number): TitleRow | undefined {
    return this.db.prepare('SELECT * FROM titles WHERE id = ?').get(id) as TitleRow | undefined;
  }

  byTmdb(mediaType: MediaType, tmdbId: number): TitleRow | undefined {
    return this.db.prepare('SELECT * FROM titles WHERE media_type = ? AND tmdb_id = ?').get(mediaType, tmdbId) as TitleRow | undefined;
  }

  /**
   * Finds or creates the canonical title for a seed. Identifier precedence: TMDb, IMDb, TVDB.
   * Missing identifiers on an existing row are filled in; existing values are never overwritten.
   */
  ensure(seed: TitleSeed): number {
    const find = (sql: string, ...args: unknown[]) => this.db.prepare(sql).get(...args) as TitleRow | undefined;
    let row: TitleRow | undefined;
    if (seed.tmdbId) row = find('SELECT * FROM titles WHERE media_type = ? AND tmdb_id = ?', seed.mediaType, seed.tmdbId);
    if (!row && seed.imdbId) row = find('SELECT * FROM titles WHERE media_type = ? AND imdb_id = ? AND (tmdb_id IS NULL OR ? IS NULL)', seed.mediaType, seed.imdbId, seed.tmdbId ?? null);
    if (!row && seed.tvdbId && seed.mediaType === 'tv') row = find('SELECT * FROM titles WHERE media_type = ? AND tvdb_id = ? AND (tmdb_id IS NULL OR ? IS NULL)', 'tv', seed.tvdbId, seed.tmdbId ?? null);

    const now = nowIso();
    if (row) {
      this.db
        .prepare(
          `UPDATE titles SET tmdb_id = COALESCE(tmdb_id, ?), imdb_id = COALESCE(imdb_id, ?), tvdb_id = COALESCE(tvdb_id, ?),
             year = COALESCE(year, ?), overview = COALESCE(overview, ?), poster_path = COALESCE(poster_path, ?), updated_at = ? WHERE id = ?`,
        )
        .run(seed.tmdbId ?? null, seed.imdbId ?? null, seed.tvdbId ?? null, seed.year ?? null, seed.overview ?? null, seed.posterPath ?? null, now, row.id);
      return row.id;
    }
    const info = this.db
      .prepare(
        `INSERT INTO titles (media_type, tmdb_id, imdb_id, tvdb_id, title, year, overview, poster_path, genres, metadata_source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        seed.mediaType,
        seed.tmdbId ?? null,
        seed.imdbId ?? null,
        seed.tvdbId ?? null,
        seed.title,
        seed.year ?? null,
        seed.overview ?? null,
        seed.posterPath ?? null,
        JSON.stringify(seed.genres ?? []),
        seed.source ?? null,
        now,
        now,
      );
    return Number(info.lastInsertRowid);
  }

  /** Applies authoritative metadata. Merges duplicate rows if another row already owns the TMDb id. */
  applyMetadata(titleId: number, meta: TitleMetadata, source: string): number {
    return this.db.transaction(() => {
      let id = titleId;
      const owner = this.byTmdb(meta.mediaType, meta.tmdbId);
      if (owner && owner.id !== titleId) {
        this.merge(titleId, owner.id);
        id = owner.id;
      }
      this.db
        .prepare(
          `UPDATE titles SET media_type = ?, tmdb_id = ?, imdb_id = COALESCE(?, imdb_id), tvdb_id = COALESCE(?, tvdb_id), title = ?, original_title = ?,
             year = COALESCE(?, year), release_date = ?, overview = COALESCE(?, overview), poster_path = COALESCE(?, poster_path),
             backdrop_path = COALESCE(?, backdrop_path), genres = ?, runtime = ?, episode_count = ?, season_count = ?, seasons = ?,
             metadata_source = ?, metadata_updated_at = ?, metadata_error = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          meta.mediaType,
          meta.tmdbId,
          meta.imdbId,
          meta.tvdbId,
          meta.title,
          meta.originalTitle,
          meta.year,
          meta.releaseDate,
          meta.overview,
          meta.posterPath,
          meta.backdropPath,
          JSON.stringify(meta.genres),
          meta.runtime,
          meta.episodeCount ?? null,
          meta.seasonCount ?? null,
          meta.seasons ? JSON.stringify(meta.seasons.filter((x) => x.seasonNumber > 0).map((x) => ({ season: x.seasonNumber, episodes: x.episodeCount }))) : null,
          source,
          nowIso(),
          nowIso(),
          id,
        );
      return id;
    })();
  }

  markMetadataError(titleId: number, message: string): void {
    this.db.prepare('UPDATE titles SET metadata_error = ?, metadata_updated_at = ? WHERE id = ?').run(message.slice(0, 300), nowIso(), titleId);
  }

  /** Repoints every reference from one title row to another and removes the duplicate. */
  merge(fromId: number, intoId: number): void {
    if (fromId === intoId) return;
    this.db.transaction(() => {
      for (const table of ['list_items', 'jellyfin_items', 'requests', 'activity', 'match_resolutions']) {
        this.db.prepare(`UPDATE ${table} SET title_id = ? WHERE title_id = ?`).run(intoId, fromId);
      }
      // Keyed by title: keep the surviving row's entry when both exist (the rest cascades away).
      for (const table of ['watch_history', 'watched_episodes', 'manual_watches']) {
        this.db.prepare(`UPDATE OR IGNORE ${table} SET title_id = ? WHERE title_id = ?`).run(intoId, fromId);
      }
      this.db.prepare('DELETE FROM titles WHERE id = ?').run(fromId);
    })();
  }

  genres(row: TitleRow): string[] {
    return parseJson<string[]>(row.genres, []);
  }
}
