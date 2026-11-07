/**
 * Serves the in-process Jellyfin and Seerr fakes over real HTTP for manual UI testing:
 *   npx tsx tests/helpers/serve-mocks.ts
 * Then configure JellyWatcher with http://127.0.0.1:18096 (key jf-secret-key) and
 * http://127.0.0.1:15055 (key seerr-secret-key). Jellyfin login: alice / alicepw.
 * For the Janitor (JW_JANITOR=1): Sonarr http://127.0.0.1:18989 (sonarr-secret-key), Radarr
 * http://127.0.0.1:17878 (radarr-secret-key), Home Assistant http://127.0.0.1:18123 (token
 * ha-long-lived-token, service mobile_app_test). Seerr has requests for Heat and Severance by Admin.
 * Development only — never shown as live data.
 */
import http from 'node:http';
import { HA, JF, RADARR, SEERR, SONARR, createMocks } from './mocks';

const mocks = createMocks();
mocks.state.seerrMedia.set('tv:95396', { id: 2, tmdbId: 95396, tvdbId: 371980, mediaType: 'tv', status: 4 });
mocks.state.seerrRequests.push(
  { id: 500, status: 2, is4k: false, media: { id: 1, tmdbId: 949, mediaType: 'movie', status: 5 }, requestedBy: { id: 1, displayName: 'Admin' }, seasons: [], createdAt: '2026-08-01T00:00:00.000Z' },
  { id: 501, status: 2, is4k: false, media: { id: 2, tmdbId: 95396, tvdbId: 371980, mediaType: 'tv', status: 4 }, requestedBy: { id: 1, displayName: 'Admin' }, seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }], createdAt: '2026-08-01T00:00:00.000Z' },
);

function serve(port: number, origin: string) {
  http
    .createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : (v ?? '')]));
      try {
        const r = await mocks.fetch(`${origin}${req.url}`, { method: req.method, headers, body: body || undefined });
        res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch (err) {
        res.writeHead(500);
        res.end(String(err));
      }
    })
    .listen(port, '127.0.0.1', () => console.log(`mock ${origin} on http://127.0.0.1:${port}`));
}

serve(18096, JF.url);
serve(15055, SEERR.url);
serve(18989, SONARR.url);
serve(17878, RADARR.url);
serve(18123, HA.url);
