import { describe, expect, it } from 'vitest';
import { SeerrMediaStatus as M, SeerrRequestStatus as R, lifecycleStage, mapSeerrMediaOnly, mapSeerrRequest, mapViewing } from '../shared/status';

describe('mapSeerrRequest', () => {
  it.each([
    [R.PENDING, M.PENDING, 'pending_approval'],
    [R.APPROVED, M.PENDING, 'approved'],
    [R.APPROVED, M.PROCESSING, 'processing'],
    [R.APPROVED, M.PARTIALLY_AVAILABLE, 'partially_available'],
    [R.APPROVED, M.AVAILABLE, 'available'],
    [R.DECLINED, M.UNKNOWN, 'declined'],
    [R.FAILED, M.PROCESSING, 'failed'],
    [R.COMPLETED, M.AVAILABLE, 'available'],
    [R.COMPLETED, M.PARTIALLY_AVAILABLE, 'partially_available'],
    [99, M.AVAILABLE, 'unknown'],
  ] as const)('request %s + media %s → %s', (req, media, expected) => {
    expect(mapSeerrRequest(req, media)).toBe(expected);
  });

  it('falls back to media status when no request status is known', () => {
    expect(mapSeerrRequest(null, M.AVAILABLE)).toBe('available');
  });
});

describe('mapSeerrMediaOnly', () => {
  it('treats unknown/deleted/missing media as not requested', () => {
    expect(mapSeerrMediaOnly(M.UNKNOWN)).toBe('not_requested');
    expect(mapSeerrMediaOnly(M.DELETED)).toBe('not_requested');
    expect(mapSeerrMediaOnly(undefined)).toBe('not_requested');
    expect(mapSeerrMediaOnly(M.BLOCKLISTED)).toBe('blocklisted');
    expect(mapSeerrMediaOnly(42)).toBe('unknown');
  });
});

describe('mapViewing', () => {
  it('handles movies', () => {
    expect(mapViewing('movie', null)).toBe('unavailable');
    expect(mapViewing('movie', { played: true, playedPercentage: null, positionTicks: 0, unplayedCount: null, episodeCount: null })).toBe('watched');
    expect(mapViewing('movie', { played: false, playedPercentage: 40, positionTicks: 1e9, unplayedCount: null, episodeCount: null })).toBe('in_progress');
    expect(mapViewing('movie', { played: false, playedPercentage: null, positionTicks: 0, unplayedCount: null, episodeCount: null })).toBe('unwatched');
  });
  it('handles series from episode counts', () => {
    expect(mapViewing('tv', { played: false, playedPercentage: 30, positionTicks: 0, unplayedCount: 7, episodeCount: 10 })).toBe('in_progress');
    expect(mapViewing('tv', { played: false, playedPercentage: 0, positionTicks: 0, unplayedCount: 10, episodeCount: 10 })).toBe('unwatched');
    expect(mapViewing('tv', { played: true, playedPercentage: 100, positionTicks: 0, unplayedCount: 0, episodeCount: 10 })).toBe('watched');
    // Jellyfin reports Played for a series with no episodes; that must not read as "watched".
    expect(mapViewing('tv', { played: true, playedPercentage: null, positionTicks: 0, unplayedCount: 0, episodeCount: 0 })).toBe('unwatched');
  });
});

describe('lifecycleStage', () => {
  it('orders viewing over library over requests', () => {
    expect(lifecycleStage('in_library', 'available', 'watched')).toBe('watched');
    expect(lifecycleStage('in_library', 'available', 'unwatched')).toBe('in_library');
    expect(lifecycleStage('not_in_library', 'processing', 'unavailable')).toBe('processing');
    expect(lifecycleStage('not_in_library', 'not_requested', 'unavailable')).toBe('listed');
    expect(lifecycleStage('unknown', 'unknown', 'unavailable')).toBe('unknown');
  });
  it('does not claim "In Library" when only Seerr reports availability', () => {
    expect(lifecycleStage('not_in_library', 'available', 'unavailable')).toBe('reported_available');
    expect(lifecycleStage('unknown', 'available', 'unavailable')).toBe('reported_available');
  });
});
