/**
 * Serves the in-process Jellyfin and Seerr fakes over real HTTP for manual UI testing:
 *   npx tsx tests/helpers/serve-mocks.ts
 * Then configure JellyWatcher with http://127.0.0.1:18096 (key jf-secret-key) and
 * http://127.0.0.1:15055 (key seerr-secret-key). Jellyfin login: alice / alicepw.
 * Development only — never shown as live data.
 */
import http from 'node:http';
import { JF, SEERR, createMocks } from './mocks';

const mocks = createMocks();

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
