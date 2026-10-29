import type { Logger } from 'pino';
import { nowIso, parseJson, type DB } from '../db/index.js';
import { decideMatch, matchFingerprint, type MatchCandidate, type MediaType } from '../domain/matching.js';
import { ProviderError } from '../http/errors.js';
import type { MetadataSource } from './metadata.js';
import type { TitleService } from './titles.js';

interface PendingRow {
  id: number;
  user_id: number;
  provider: string;
  media_type: MediaType | null;
  source_title: string;
  source_year: number | null;
  tmdb_id: number | null;
  imdb_id: string | null;
  tvdb_id: number | null;
  source_url: string | null;
  match_attempts: number;
}

export interface MatchStats {
  processed: number;
  matched: number;
  review: number;
  unmatched: number;
  ignored: number;
  deferred: number;
}

const MAX_ATTEMPTS = 5;

type Outcome = { status: 'matched' | 'review' | 'unmatched' | 'ignored' | 'deferred'; titleId?: number | null; method?: string; confidence?: number; candidates?: unknown[] };

/**
 * Resolves imported entries to canonical titles. Order: stored user decision → TMDb id → IMDb id →
 * TVDB id → fuzzy title/year search. Uncertain results go to the review queue instead of guessing.
 */
export class Matcher {
  constructor(
    private readonly db: DB,
    private readonly titles: TitleService,
    private readonly log: Logger,
  ) {}

  pendingCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM list_items WHERE match_status = 'pending'").get() as { n: number }).n;
  }

  fingerprint(row: Pick<PendingRow, 'provider' | 'source_url' | 'source_title' | 'source_year' | 'media_type'>): string {
    return matchFingerprint(row.provider, { sourceUrl: row.source_url, title: row.source_title, year: row.source_year, mediaType: row.media_type });
  }

  async run(meta: MetadataSource | null, limit = 400): Promise<MatchStats> {
    const rows = this.db
      .prepare(
        `SELECT li.id, l.user_id, l.provider, li.media_type, li.source_title, li.source_year, li.tmdb_id, li.imdb_id, li.tvdb_id, li.source_url, li.match_attempts
           FROM list_items li JOIN lists l ON l.id = li.list_id
          WHERE li.match_status = 'pending' ORDER BY li.id LIMIT ?`,
      )
      .all(limit) as PendingRow[];
    const stats: MatchStats = { processed: 0, matched: 0, review: 0, unmatched: 0, ignored: 0, deferred: 0 };
    const cache = new Map<string, Outcome>();

    for (const row of rows) {
      stats.processed++;
      try {
        // Decisions are per person; everything after them is the same for everyone and cached.
        let outcome: Outcome | undefined = this.decided(row);
        if (!outcome) {
          const key = `${this.fingerprint(row)}|${row.tmdb_id ?? ''}|${row.imdb_id ?? ''}`;
          outcome = cache.get(key) ?? (await this.resolve(row, meta));
          cache.set(key, outcome);
        }
        if (outcome.status === 'deferred') {
          stats.deferred++;
          continue;
        }
        this.db
          .prepare('UPDATE list_items SET title_id = ?, match_status = ?, match_method = ?, match_confidence = ?, match_candidates = ?, match_attempts = match_attempts + 1 WHERE id = ?')
          .run(outcome.titleId ?? null, outcome.status, outcome.method ?? null, outcome.confidence ?? null, outcome.candidates ? JSON.stringify(outcome.candidates) : null, row.id);
        stats[outcome.status]++;
      } catch (err) {
        const retryable = err instanceof ProviderError && err.retryable;
        if (retryable && row.match_attempts + 1 < MAX_ATTEMPTS) {
          this.db.prepare('UPDATE list_items SET match_attempts = match_attempts + 1 WHERE id = ?').run(row.id);
          stats.deferred++;
          if (err instanceof ProviderError && err.kind === 'rate_limited') break;
        } else {
          this.log.warn({ err: (err as Error).message, item: row.id }, 'match failed');
          this.db.prepare("UPDATE list_items SET match_status = 'unmatched', match_attempts = match_attempts + 1 WHERE id = ?").run(row.id);
          stats.unmatched++;
        }
      }
    }
    return stats;
  }

  /**
   * 1. A person already decided how this entry maps: the list owner, or else an administrator.
   * Other users' decisions never apply, so nobody can steer how someone else's entries match.
   */
  private decided(row: PendingRow): Outcome | undefined {
    const decision = this.db
      .prepare(
        `SELECT r.title_id, r.ignored FROM match_resolutions r JOIN users u ON u.id = r.user_id
          WHERE r.fingerprint = ? AND (r.user_id = ? OR u.role = 'admin')
          ORDER BY (r.user_id = ?) DESC, r.created_at DESC LIMIT 1`,
      )
      .get(this.fingerprint(row), row.user_id, row.user_id) as
      | { title_id: number | null; ignored: number }
      | undefined;
    if (decision?.ignored) return { status: 'ignored', method: 'manual' };
    if (decision?.title_id && this.titles.get(decision.title_id)) return { status: 'matched', titleId: decision.title_id, method: 'manual', confidence: 1 };
    return undefined;
  }

  private async resolve(row: PendingRow, meta: MetadataSource | null): Promise<Outcome> {
    // 2. Source supplied a TMDb id: exact.
    if (row.tmdb_id && row.media_type) {
      const titleId = this.titles.ensure({ mediaType: row.media_type, tmdbId: row.tmdb_id, imdbId: row.imdb_id, tvdbId: row.tvdb_id, title: row.source_title, year: row.source_year, source: row.provider });
      return { status: 'matched', titleId, method: 'tmdb_id', confidence: 1 };
    }

    // 3. IMDb id: known locally, or resolved through the metadata source.
    if (row.imdb_id) {
      const local = this.db.prepare('SELECT id FROM titles WHERE imdb_id = ? AND (? IS NULL OR media_type = ?) LIMIT 1').get(row.imdb_id, row.media_type, row.media_type) as { id: number } | undefined;
      if (local) return { status: 'matched', titleId: local.id, method: 'imdb_id', confidence: 1 };
      if (!meta) return { status: 'deferred' };
      const found = await meta.findByImdb(row.imdb_id);
      const hit = found.find((c) => !row.media_type || c.mediaType === row.media_type) ?? found[0];
      if (hit) {
        const titleId = this.titles.ensure({ mediaType: hit.mediaType, tmdbId: hit.tmdbId, imdbId: row.imdb_id, title: hit.title || row.source_title, year: hit.year ?? row.source_year, posterPath: hit.posterPath, overview: hit.overview, source: meta.name });
        return { status: 'matched', titleId, method: 'imdb_id', confidence: 1 };
      }
    }

    // 4. TVDB id for shows.
    if (row.tvdb_id && row.media_type === 'tv' && meta) {
      const found = (await meta.findByTvdb(row.tvdb_id)).filter((c) => c.mediaType === 'tv');
      if (found[0]) {
        const titleId = this.titles.ensure({ mediaType: 'tv', tmdbId: found[0].tmdbId, tvdbId: row.tvdb_id, title: found[0].title, year: found[0].year, posterPath: found[0].posterPath, source: meta.name });
        return { status: 'matched', titleId, method: 'tvdb_id', confidence: 1 };
      }
    }

    // 5. Fuzzy title + year search.
    if (!meta) return { status: 'deferred' };
    const types: MediaType[] = row.media_type ? [row.media_type] : ['movie', 'tv'];
    const candidates: MatchCandidate[] = [];
    for (const t of types) candidates.push(...(await meta.search(t, row.source_title, row.source_year)));
    const decisionResult = decideMatch({ title: row.source_title, year: row.source_year, mediaType: row.media_type }, candidates);
    const compact = decisionResult.candidates.map((c) => ({ tmdbId: c.tmdbId, mediaType: c.mediaType, title: c.title, year: c.year, posterPath: c.posterPath ?? null, score: c.score }));
    if (decisionResult.status === 'matched' && decisionResult.best) {
      const b = decisionResult.best;
      const titleId = this.titles.ensure({ mediaType: b.mediaType, tmdbId: b.tmdbId, title: b.title, year: b.year, posterPath: b.posterPath, overview: b.overview, source: meta.name });
      return { status: 'matched', titleId, method: 'title_year', confidence: decisionResult.confidence, candidates: compact };
    }
    return { status: decisionResult.status, titleId: null, method: 'title_year', confidence: decisionResult.confidence, candidates: compact };
  }

  /** Applies a person's decision to every entry with the same fingerprint and remembers it. */
  resolveManually(itemId: number, userId: number, choice: { tmdbId: number; mediaType: MediaType; title: string; year: number | null } | 'ignore'): number {
    const row = this.db
      .prepare('SELECT li.*, l.provider FROM list_items li JOIN lists l ON l.id = li.list_id WHERE li.id = ? AND l.user_id = ?')
      .get(itemId, userId) as (PendingRow & { list_id: number }) | undefined;
    if (!row) return 0;
    const fp = this.fingerprint(row);
    return this.db.transaction(() => {
      let titleId: number | null = null;
      if (choice !== 'ignore') titleId = this.titles.ensure({ mediaType: choice.mediaType, tmdbId: choice.tmdbId, title: choice.title, year: choice.year, source: 'manual' });
      this.db
        .prepare('INSERT INTO match_resolutions (fingerprint, user_id, title_id, ignored, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(fingerprint, user_id) DO UPDATE SET title_id = excluded.title_id, ignored = excluded.ignored, created_at = excluded.created_at')
        .run(fp, userId, titleId, choice === 'ignore' ? 1 : 0, nowIso());
      // Apply to all of this user's entries with the same fingerprint.
      const siblings = this.db
        .prepare('SELECT li.id, l.provider, li.source_url, li.source_title, li.source_year, li.media_type FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.user_id = ? AND li.match_status IN (\'review\', \'unmatched\', \'pending\', \'matched\', \'ignored\')')
        .all(userId) as PendingRow[];
      let n = 0;
      for (const s of siblings) {
        if (this.fingerprint(s) !== fp) continue;
        this.db
          .prepare('UPDATE list_items SET title_id = ?, match_status = ?, match_method = ?, match_confidence = ? WHERE id = ?')
          .run(titleId, choice === 'ignore' ? 'ignored' : 'matched', 'manual', choice === 'ignore' ? null : 1, s.id);
        n++;
      }
      return n;
    })();
  }

  candidates(itemId: number): unknown[] {
    const row = this.db.prepare('SELECT match_candidates FROM list_items WHERE id = ?').get(itemId) as { match_candidates: string | null } | undefined;
    return parseJson(row?.match_candidates, []);
  }
}
