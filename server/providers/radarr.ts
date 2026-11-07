import { z } from 'zod';
import { HttpClient, type FetchLike } from '../http/client.js';

/**
 * Radarr v3+ API adapter (Janitor only). Base {url}/api/v3, header X-Api-Key.
 *  - GET /movie (all), DELETE /movie/{id}?deleteFiles=true&addImportExclusion=
 */

const Movie = z.object({
  id: z.number(),
  title: z.string().nullish(),
  tmdbId: z.number().nullish(),
  imdbId: z.string().nullish(),
  hasFile: z.boolean().nullish(),
  sizeOnDisk: z.number().nullish(),
  monitored: z.boolean().nullish(),
});
export type RadarrMovie = z.infer<typeof Movie>;

export class RadarrClient {
  readonly http: HttpClient;

  constructor(baseUrl: string, apiKey: string, fetchImpl?: FetchLike) {
    this.http = new HttpClient({
      provider: 'radarr',
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

  async movies(): Promise<RadarrMovie[]> {
    const res = await this.http.get('/movie');
    const list = z.array(z.unknown()).parse(res.data);
    return list.map((x) => Movie.safeParse(x)).filter((r) => r.success).map((r) => r.data!);
  }

  /** Deletes the movie with its files. False when it was already gone. */
  async deleteMovie(movieId: number, opts: { importExclusion: boolean }): Promise<boolean> {
    const res = await this.http.delete(`/movie/${movieId}`, { deleteFiles: true, addImportExclusion: opts.importExclusion }, { acceptStatus: [404] });
    return res.status !== 404;
  }
}
