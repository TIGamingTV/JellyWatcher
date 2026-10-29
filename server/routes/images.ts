import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { HttpClient } from '../http/client.js';
import { parse } from '../http/validate.js';
import { requireUser } from '../security/auth.js';
import { TMDB_IMAGE_BASE } from '../providers/tmdb.js';

const TMDB_SIZES = ['w92', 'w154', 'w185', 'w342', 'w500', 'w780', 'w1280'] as const;
const JF_WIDTHS = [185, 342, 500, 780] as const;
const MAX_BYTES = 8 * 1024 * 1024;
const CACHE_DAYS = 30;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

/**
 * Same-origin image proxy with a disk cache. It lets the browser show Jellyfin artwork even when the
 * Jellyfin URL is only reachable from the server, keeps a strict CSP (img-src 'self'), and only ever
 * fetches from TMDb's image CDN or the configured Jellyfin server — never from arbitrary URLs.
 */
export async function imageRoutes(app: FastifyInstance, { ctx }: AppDeps) {
  const cacheDir = path.join(ctx.config.dataDir, 'cache', 'images');
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmdbHttp = new HttpClient({ provider: 'tmdb-images', baseUrl: TMDB_IMAGE_BASE, timeoutMs: 15_000, retries: 1 });
  const inflight = new Map<string, Promise<{ data: Buffer; type: string } | null>>();

  const cached = (key: string) => {
    const file = path.join(cacheDir, key.slice(0, 2), key);
    return { file, meta: `${file}.type` };
  };

  /** `allowFetch` is checked only on a cache miss, so cached images cost no extra lookup. */
  async function serve(reply: FastifyReply, key: string, fetcher: () => Promise<{ data: Buffer; type: string }>, allowFetch: () => boolean = () => true) {
    const { file, meta } = cached(key);
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < CACHE_DAYS * 86400_000) {
        const stored = fs.existsSync(meta) ? fs.readFileSync(meta, 'utf8').trim() : 'image/jpeg';
        const type = IMAGE_TYPES.has(stored) ? stored : 'application/octet-stream';
        return reply.header('Content-Type', type).header('Cache-Control', 'private, max-age=604800').send(fs.createReadStream(file));
      }
    } catch {
      /* not cached */
    }
    let p = inflight.get(key);
    if (!p && !allowFetch()) return reply.status(404).header('Cache-Control', 'no-store').send();
    if (!p) {
      p = fetcher()
        .then((img) => {
          // Raster formats only: an SVG could carry script, and the plugin serves these from Jellyfin's origin.
          img = { ...img, type: img.type.split(';')[0]!.trim().toLowerCase() };
          if (!IMAGE_TYPES.has(img.type) || img.data.length > MAX_BYTES) return null;
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(`${file}.tmp`, img.data);
          fs.renameSync(`${file}.tmp`, file);
          fs.writeFileSync(meta, img.type);
          return img;
        })
        .catch(() => null)
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    const img = await p;
    if (!img) return reply.status(404).header('Cache-Control', 'no-store').send();
    return reply.header('Content-Type', img.type).header('Cache-Control', 'private, max-age=604800').send(img.data);
  }

  const knownTmdbImage = ctx.db.prepare('SELECT 1 FROM titles WHERE poster_path = ? OR backdrop_path = ? LIMIT 1');
  const knownJellyfinItem = ctx.db.prepare('SELECT 1 FROM jellyfin_items WHERE id = ?');

  app.get('/images/tmdb/:size/:file', async (req, reply) => {
    // TMDb artwork is public; the Jellyfin plugin fetches it with its key alone (for <img> tags).
    if (!req.viaPlugin) requireUser(req);
    const p = parse(z.object({ size: z.enum(TMDB_SIZES), file: z.string().regex(/^[A-Za-z0-9_-]{1,100}\.(jpg|jpeg|png|webp)$/i) }), req.params);
    const key = crypto.createHash('sha1').update(`tmdb:${p.size}:${p.file}`).digest('hex');
    // The plugin's image route is reachable without a Jellyfin sign-in (img tags send no auth), so
    // such requests only get artwork of titles JellyWatcher knows: no open proxy, no cache filling.
    const anonymous = req.viaPlugin && !req.user;
    return serve(
      reply,
      key,
      async () => {
        const res = await tmdbHttp.request<Buffer>({ path: `/${p.size}/${p.file}`, responseType: 'buffer', headers: { Accept: 'image/*' } });
        return { data: res.data, type: res.headers.get('content-type') ?? 'image/jpeg' };
      },
      () => !anonymous || Boolean(knownTmdbImage.get(`/${p.file}`, `/${p.file}`)),
    );
  });

  app.get('/images/jellyfin/:itemId', async (req, reply) => {
    requireUser(req);
    const p = parse(z.object({ itemId: z.string().regex(/^[a-f0-9-]{32,36}$/i) }), req.params);
    // Only items from the indexed library, not any item id the Jellyfin API key could read.
    if (!knownJellyfinItem.get(p.itemId)) return reply.status(404).header('Cache-Control', 'no-store').send();
    const q = parse(z.object({ tag: z.string().regex(/^[A-Za-z0-9]{1,64}$/).optional(), w: z.coerce.number().int().optional() }), req.query);
    const width = JF_WIDTHS.find((w) => w >= (q.w ?? 342)) ?? 342;
    const jf = ctx.integrations.jellyfin();
    if (!jf) return reply.status(404).send();
    const key = crypto.createHash('sha1').update(`jf:${p.itemId}:${q.tag ?? ''}:${width}`).digest('hex');
    return serve(reply, key, async () => {
      const img = await jf.image(p.itemId, { tag: q.tag, maxWidth: width });
      return { data: img.data, type: img.contentType };
    });
  });
}
