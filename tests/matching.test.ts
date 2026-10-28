import { describe, expect, it } from 'vitest';
import { decideMatch, matchFingerprint, normalizeTitle, scoreCandidate, titleSimilarity, type MatchCandidate } from '../server/domain/matching';

const c = (tmdbId: number, title: string, year: number | null, mediaType: 'movie' | 'tv' = 'movie', extra: Partial<MatchCandidate> = {}): MatchCandidate => ({ tmdbId, title, year, mediaType, ...extra });

describe('normalizeTitle', () => {
  it('strips accents, punctuation, leading articles and normalises roman numerals', () => {
    expect(normalizeTitle('The Godfather: Part II')).toBe('godfather part 2');
    expect(normalizeTitle('Amélie')).toBe('amelie');
    expect(normalizeTitle('Fast & Furious')).toBe('fast and furious');
    expect(normalizeTitle("Schindler's List")).toBe('schindlers list');
    expect(normalizeTitle('A Quiet Place')).toBe('quiet place');
  });
  it('keeps articles that are not leading', () => {
    expect(normalizeTitle('Into the Wild')).toBe('into the wild');
  });
});

describe('titleSimilarity', () => {
  it('is 1 for equal normalised titles and lower for different ones', () => {
    expect(titleSimilarity('The Matrix', 'Matrix')).toBe(1);
    expect(titleSimilarity('The Matrix', 'The Matrix Reloaded')).toBeLessThan(0.8);
    expect(titleSimilarity('Heat', 'Cold')).toBeLessThan(0.3);
  });
});

describe('decideMatch', () => {
  it('auto-accepts an exact, unambiguous title + year match', () => {
    const d = decideMatch({ title: 'Heat', year: 1995, mediaType: 'movie' }, [c(949, 'Heat', 1995), c(1, 'Heat', 1986), c(2, 'Heat Wave', 2020)]);
    expect(d.status).toBe('matched');
    expect(d.best?.tmdbId).toBe(949);
  });

  it('accepts a one-year release difference when it is still unambiguous', () => {
    const d = decideMatch({ title: 'Drive My Car', year: 2022, mediaType: 'movie' }, [c(758866, 'Drive My Car', 2021)]);
    expect(d.status).toBe('matched');
  });

  it('sends remakes with the same title and no year to review', () => {
    const d = decideMatch({ title: 'Dune', year: null, mediaType: 'movie' }, [c(438631, 'Dune', 2021), c(841, 'Dune', 1984)]);
    expect(d.status).toBe('review');
    expect(d.candidates).toHaveLength(2);
  });

  it('does not auto-accept a fuzzy (non-exact) title', () => {
    const d = decideMatch({ title: 'Godfather 2', year: 1974, mediaType: 'movie' }, [c(240, 'The Godfather Part II', 1974)]);
    expect(d.status).not.toBe('matched');
  });

  it('penalises the wrong media type', () => {
    const movie = scoreCandidate({ title: 'Fargo', year: 1996, mediaType: 'movie' }, c(275, 'Fargo', 1996, 'movie'));
    const show = scoreCandidate({ title: 'Fargo', year: 1996, mediaType: 'movie' }, c(60622, 'Fargo', 2014, 'tv'));
    expect(movie).toBeGreaterThan(show + 0.3);
  });

  it('matches against the original title', () => {
    const d = decideMatch({ title: 'Les Intouchables', year: 2011, mediaType: 'movie' }, [c(77338, 'The Intouchables', 2011, 'movie', { originalTitle: 'Intouchables' })]);
    expect(d.best?.tmdbId).toBe(77338);
  });

  it('returns unmatched with no candidates', () => {
    expect(decideMatch({ title: 'x', year: null, mediaType: null }, []).status).toBe('unmatched');
  });
});

describe('matchFingerprint', () => {
  it('prefers the source URL and is case/trailing-slash insensitive', () => {
    expect(matchFingerprint('letterboxd', { sourceUrl: 'https://boxd.it/AbC/', title: 'x', year: 1, mediaType: 'movie' })).toBe(
      matchFingerprint('letterboxd', { sourceUrl: 'https://boxd.it/abc', title: 'y', year: 2, mediaType: 'movie' }),
    );
  });
  it('falls back to normalised title and year', () => {
    expect(matchFingerprint('imdb', { title: 'The Thing', year: 1982, mediaType: 'movie' })).toBe('imdb:t:movie:thing:1982');
  });
});
