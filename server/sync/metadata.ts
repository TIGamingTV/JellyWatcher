import type { AppContext } from '../context.js';
import { ProviderError, errorMessage } from '../http/errors.js';
import type { MediaType } from '../domain/matching.js';

const REFRESH_DAYS = 30;
const CONCURRENCY = 4;

/**
 * Enriches titles that appear in someone's lists or requests with authoritative metadata
 * (TMDb directly, or Seerr's TMDb proxy). Library-only titles are enriched lazily when opened.
 */
export async function syncMetadata(ctx: AppContext, limit = 250) {
  const meta = ctx.metadata();
  if (!meta) return { status: 'skipped' as const, stats: { reason: 'no metadata source (configure TMDb or Seerr)' } };
  const cutoff = new Date(Date.now() - REFRESH_DAYS * 86400_000).toISOString();
  const rows = ctx.db
    .prepare(
      `SELECT t.id, t.media_type, t.tmdb_id FROM titles t
        WHERE t.tmdb_id IS NOT NULL
          AND (t.metadata_updated_at IS NULL OR t.metadata_updated_at < ? OR t.metadata_source NOT IN ('tmdb', 'seerr'))
          AND (EXISTS (SELECT 1 FROM list_items li WHERE li.title_id = t.id) OR EXISTS (SELECT 1 FROM requests r WHERE r.title_id = t.id))
          AND (t.metadata_error IS NULL OR t.metadata_updated_at < ?)
        ORDER BY t.metadata_updated_at ASC NULLS FIRST LIMIT ?`,
    )
    .all(cutoff, cutoff, limit) as { id: number; media_type: MediaType; tmdb_id: number }[];

  let updated = 0;
  let failed = 0;
  let stop = false;
  const queue = [...rows];
  const worker = async () => {
    while (!stop) {
      const row = queue.shift();
      if (!row) return;
      try {
        const m = await meta.details(row.media_type, row.tmdb_id);
        if (m) {
          ctx.titles.applyMetadata(row.id, m, meta.name);
          updated++;
        } else {
          ctx.titles.markMetadataError(row.id, 'Not found in TMDb');
          failed++;
        }
      } catch (err) {
        failed++;
        if (err instanceof ProviderError && (err.kind === 'rate_limited' || err.kind === 'auth' || err.kind === 'network')) {
          stop = true;
          throw err;
        }
        ctx.titles.markMetadataError(row.id, errorMessage(err));
      }
    }
  };
  const results = await Promise.allSettled(Array.from({ length: CONCURRENCY }, worker));
  const fatal = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
  if (fatal && updated === 0) throw fatal.reason;
  return { status: failed > 0 || fatal ? ('partial' as const) : ('ok' as const), stats: { candidates: rows.length, updated, failed, source: meta.name } };
}

/** Fetches metadata for a single title on demand (title detail view). */
export async function ensureTitleMetadata(ctx: AppContext, titleId: number): Promise<number> {
  const t = ctx.titles.get(titleId);
  if (!t || !t.tmdb_id) return titleId;
  const fresh = t.metadata_updated_at && (t.metadata_source === 'tmdb' || t.metadata_source === 'seerr') && Date.now() - Date.parse(t.metadata_updated_at) < REFRESH_DAYS * 86400_000;
  if (fresh) return titleId;
  const meta = ctx.metadata();
  if (!meta) return titleId;
  try {
    const m = await meta.details(t.media_type, t.tmdb_id);
    if (m) return ctx.titles.applyMetadata(titleId, m, meta.name);
  } catch (err) {
    ctx.log.debug({ err: errorMessage(err) }, 'on-demand metadata failed');
  }
  return titleId;
}
