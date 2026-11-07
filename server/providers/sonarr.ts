import { z } from 'zod';
import { HttpClient, type FetchLike } from '../http/client.js';
import { ProviderError } from '../http/errors.js';

/**
 * Sonarr v3/v4 API adapter (Janitor only). Base {url}/api/v3, header X-Api-Key.
 *  - GET /series (all, with per-season statistics), GET /series/{id}, PUT /series/{id}
 *  - GET /episodefile?seriesId=, DELETE /episodefile/{id}
 *  - DELETE /series/{id}?deleteFiles=true&addImportListExclusion=
 */

const SeasonStats = z.object({
  episodeFileCount: z.number().nullish(),
  episodeCount: z.number().nullish(),
  totalEpisodeCount: z.number().nullish(),
  sizeOnDisk: z.number().nullish(),
  nextAiring: z.string().nullish(),
  previousAiring: z.string().nullish(),
});

const Series = z.object({
  id: z.number(),
  title: z.string().nullish(),
  tvdbId: z.number().nullish(),
  tmdbId: z.number().nullish(),
  imdbId: z.string().nullish(),
  status: z.string().nullish(),
  monitored: z.boolean().nullish(),
  seasons: z
    .array(z.object({ seasonNumber: z.number(), monitored: z.boolean().nullish(), statistics: SeasonStats.nullish() }).passthrough())
    .nullish(),
  statistics: SeasonStats.nullish(),
}).passthrough();
export type SonarrSeries = z.infer<typeof Series>;

const EpisodeFile = z.object({ id: z.number(), seasonNumber: z.number(), size: z.number().nullish() });
export type SonarrEpisodeFile = z.infer<typeof EpisodeFile>;

export interface SonarrSeason {
  season: number;
  monitored: boolean;
  files: number;
  /** Monitored episodes that aired or have a file (Sonarr's episodeCount). */
  episodes: number;
  total: number;
  sizeOnDisk: number;
  nextAiring: string | null;
}

export function sonarrSeasons(s: SonarrSeries): SonarrSeason[] {
  return (s.seasons ?? []).map((x) => ({
    season: x.seasonNumber,
    monitored: x.monitored ?? false,
    files: x.statistics?.episodeFileCount ?? 0,
    episodes: x.statistics?.episodeCount ?? 0,
    total: x.statistics?.totalEpisodeCount ?? 0,
    sizeOnDisk: x.statistics?.sizeOnDisk ?? 0,
    nextAiring: x.statistics?.nextAiring ?? null,
  }));
}

export class SonarrClient {
  readonly http: HttpClient;

  constructor(baseUrl: string, apiKey: string, fetchImpl?: FetchLike) {
    this.http = new HttpClient({
      provider: 'sonarr',
      baseUrl: `${baseUrl.replace(/\/+$/, '')}/api/v3`,
      headers: () => ({ 'X-Api-Key': apiKey }),
      timeoutMs: 30_000,
      fetchImpl,
    });
  }

  async status() {
    const res = await this.http.get('/system/status');
    return z.object({ version: z.string().nullish(), appName: z.string().nullish(), instanceName: z.string().nullish() }).parse(res.data);
  }

  async allSeries(): Promise<SonarrSeries[]> {
    const res = await this.http.get('/series');
    const list = z.array(z.unknown()).parse(res.data);
    return list.map((x) => Series.safeParse(x)).filter((r) => r.success).map((r) => r.data!);
  }

  async series(id: number): Promise<SonarrSeries | null> {
    try {
      const res = await this.http.get(`/series/${id}`);
      return Series.parse(res.data);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'not_found') return null;
      throw err;
    }
  }

  async episodeFiles(seriesId: number): Promise<SonarrEpisodeFile[]> {
    const res = await this.http.get('/episodefile', { seriesId });
    const list = z.array(z.unknown()).parse(res.data);
    return list.map((x) => EpisodeFile.safeParse(x)).filter((r) => r.success).map((r) => r.data!);
  }

  /** Stops Sonarr from downloading a season again (changing a season's monitoring updates its episodes). */
  async setSeasonMonitored(seriesId: number, season: number, monitored: boolean): Promise<boolean> {
    const s = await this.series(seriesId);
    if (!s) return false;
    const seasons = (s.seasons ?? []).map((x) => (x.seasonNumber === season ? { ...x, monitored } : x));
    if (!seasons.some((x) => x.seasonNumber === season)) return false;
    await this.http.put(`/series/${seriesId}`, { ...s, seasons });
    return true;
  }

  /** Deletes the files of one season. Returns the bytes freed. Files already gone count as done. */
  async deleteSeasonFiles(seriesId: number, season: number): Promise<{ files: number; bytes: number }> {
    const files = (await this.episodeFiles(seriesId)).filter((f) => f.seasonNumber === season);
    let bytes = 0;
    for (const f of files) {
      await this.http.delete(`/episodefile/${f.id}`, undefined, { acceptStatus: [404] });
      bytes += f.size ?? 0;
    }
    return { files: files.length, bytes };
  }

  /** Deletes the series with its files. False when it was already gone. */
  async deleteSeries(seriesId: number, opts: { importListExclusion: boolean }): Promise<boolean> {
    const res = await this.http.delete(`/series/${seriesId}`, { deleteFiles: true, addImportListExclusion: opts.importListExclusion }, { acceptStatus: [404] });
    return res.status !== 404;
  }
}
