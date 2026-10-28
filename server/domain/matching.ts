/**
 * Title matching for imports that do not carry shared identifiers (Letterboxd exports, IMDb rows
 * without a usable id). Identifier matches always win; fuzzy matches are scored and only accepted
 * automatically when they are unambiguous. Everything else goes to the review queue.
 */

export type MediaType = 'movie' | 'tv';

export interface MatchQuery {
  title: string;
  year: number | null;
  mediaType: MediaType | null;
}

export interface MatchCandidate {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  originalTitle?: string | null;
  year: number | null;
  posterPath?: string | null;
  overview?: string | null;
  popularity?: number | null;
}

export interface ScoredCandidate extends MatchCandidate {
  score: number;
}

export interface MatchDecision {
  status: 'matched' | 'review' | 'unmatched';
  best: ScoredCandidate | null;
  confidence: number;
  candidates: ScoredCandidate[];
}

export const AUTO_ACCEPT_SCORE = 0.9;
export const REVIEW_SCORE = 0.55;
const AMBIGUITY_MARGIN = 0.06;

const ROMAN: Record<string, string> = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };

export function normalizeTitle(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => ROMAN[w] ?? w)
    .filter((w, i) => !(i === 0 && (w === 'the' || w === 'a' || w === 'an')))
    .join(' ');
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const compact = s.replace(/\s+/g, ' ');
  for (let i = 0; i < compact.length - 1; i++) {
    const g = compact.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Sørensen–Dice similarity on character bigrams of normalised titles, 0..1. */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const ga = bigrams(na);
  const gb = bigrams(nb);
  let overlap = 0;
  for (const [g, count] of ga) overlap += Math.min(count, gb.get(g) ?? 0);
  const total = [...ga.values()].reduce((x, y) => x + y, 0) + [...gb.values()].reduce((x, y) => x + y, 0);
  return (2 * overlap) / total;
}

function yearScore(query: number | null, candidate: number | null): number {
  if (query === null || candidate === null) return 0.7;
  const delta = Math.abs(query - candidate);
  if (delta === 0) return 1;
  if (delta === 1) return 0.85; // festival vs. theatrical release years differ often
  if (delta === 2) return 0.5;
  return 0.1;
}

export function scoreCandidate(query: MatchQuery, c: MatchCandidate): number {
  const sim = Math.max(titleSimilarity(query.title, c.title), c.originalTitle ? titleSimilarity(query.title, c.originalTitle) : 0);
  let score = sim * 0.75 + yearScore(query.year, c.year) * 0.25;
  if (query.mediaType && query.mediaType !== c.mediaType) score -= 0.25;
  return Math.max(0, Math.min(1, Number(score.toFixed(4))));
}

export function decideMatch(query: MatchQuery, candidates: MatchCandidate[]): MatchDecision {
  const scored = candidates
    .map((c) => ({ ...c, score: scoreCandidate(query, c) }))
    .sort((a, b) => b.score - a.score || (b.popularity ?? 0) - (a.popularity ?? 0))
    .slice(0, 6);
  const [best, second] = scored;
  if (!best) return { status: 'unmatched', best: null, confidence: 0, candidates: [] };

  const ambiguous = second !== undefined && best.score - second.score < AMBIGUITY_MARGIN;
  const exactTitle = normalizeTitle(best.title) === normalizeTitle(query.title) ||
    (best.originalTitle ? normalizeTitle(best.originalTitle) === normalizeTitle(query.title) : false);

  if (best.score >= AUTO_ACCEPT_SCORE && exactTitle && !ambiguous) {
    return { status: 'matched', best, confidence: best.score, candidates: scored };
  }
  if (best.score >= REVIEW_SCORE) return { status: 'review', best, confidence: best.score, candidates: scored };
  return { status: 'unmatched', best: null, confidence: best.score, candidates: scored };
}

/**
 * Stable fingerprint of a source entry so a manual match decision is reused on re-import and across
 * lists (e.g. the same Letterboxd film in the watchlist and in a list export).
 */
export function matchFingerprint(provider: string, e: { sourceUrl?: string | null; title: string; year: number | null; mediaType: MediaType | null }): string {
  if (e.sourceUrl) return `${provider}:url:${e.sourceUrl.toLowerCase().replace(/\/+$/, '')}`;
  return `${provider}:t:${e.mediaType ?? '?'}:${normalizeTitle(e.title)}:${e.year ?? '?'}`;
}
