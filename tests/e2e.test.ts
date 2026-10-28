import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../server/app';
import { loadConfig } from '../server/config';
import { AppContext } from '../server/context';
import { migrate, openDatabase } from '../server/db/index';
import { SecretBox } from '../server/security/crypto';
import { syncJellyfin } from '../server/sync/jellyfin';
import { syncSeerr } from '../server/sync/seerr';
import { triggerJob } from '../server/sync/scheduler';
import { syncMetadata } from '../server/sync/metadata';
import { ALICE_JF, JF, SEERR, createMocks } from './helpers/mocks';

const SETUP_CODE = 'ABCDE-12345';

class Client {
  cookie = '';
  csrf = '';
  constructor(private readonly app: FastifyInstance) {}
  async req(method: string, url: string, body?: unknown, opts: { csrf?: boolean; headers?: Record<string, string>; raw?: { payload: Buffer; contentType: string } } = {}) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (method !== 'GET' && opts.csrf !== false && this.csrf) headers['x-csrf-token'] = this.csrf;
    let payload: string | Buffer | undefined;
    if (opts.raw) {
      payload = opts.raw.payload;
      headers['content-type'] = opts.raw.contentType;
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const res = await this.app.inject({ method: method as 'GET', url, headers, payload });
    const setCookie = res.headers['set-cookie'];
    const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (first) this.cookie = first.split(';')[0]!;
    const data = res.body ? safeJson(res.body) : undefined;
    if (data && typeof data === 'object' && 'csrfToken' in data && typeof (data as { csrfToken: unknown }).csrfToken === 'string') this.csrf = (data as { csrfToken: string }).csrfToken;
    return { status: res.statusCode, data: data as any, body: res.body, headers: res.headers };
  }
  get = (u: string) => this.req('GET', u);
  post = (u: string, b?: unknown) => this.req('POST', u, b ?? {});
  put = (u: string, b?: unknown) => this.req('PUT', u, b ?? {});
  patch = (u: string, b?: unknown) => this.req('PATCH', u, b ?? {});
  del = (u: string) => this.req('DELETE', u);
  async login(username: string, password: string) {
    const r = await this.post('/api/auth/login', { username, password });
    await this.get('/api/auth/me');
    return r;
  }
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function multipart(fields: Record<string, string>, file: { name: string; content: string; type: string }) {
  const boundary = '----jwtest' + Math.random().toString(16).slice(2);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n${file.content}\r\n`);
  parts.push(`--${boundary}--\r\n`);
  return { payload: Buffer.from(parts.join('')), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('end-to-end against mocked Jellyfin, Seerr and Trakt', () => {
  const mocks = createMocks();
  let app: FastifyInstance;
  let ctx: AppContext;
  let admin: Client;
  let dataDir: string;

  beforeAll(async () => {
    vi.stubGlobal('fetch', mocks.fetch);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jw-e2e-'));
    const config = loadConfig({ JW_DATA_DIR: dataDir, JW_LOG_FILE: '0', JW_DISABLE_SCHEDULER: '1' } as NodeJS.ProcessEnv);
    const db = openDatabase(':memory:');
    await migrate(db);
    ctx = new AppContext(config, db, SecretBox.fromMaterial('b'.repeat(64)), pino({ level: process.env.JW_TEST_LOG ?? 'silent' }));
    const users = () => (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    app = await buildApp(ctx, { setupCode: () => (users() === 0 ? SETUP_CODE : null), serveWeb: false });
    admin = new Client(app);
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllGlobals();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('requires the setup code before creating the first administrator', async () => {
    expect((await admin.get('/api/auth/me')).data.needsSetup).toBe(true);
    expect((await admin.post('/api/setup', { setupCode: 'WRONG', username: 'admin', password: 'a-long-password' })).status).toBe(403);
    const ok = await admin.post('/api/setup', { setupCode: SETUP_CODE, username: 'admin', password: 'a-long-password', displayName: 'Alice' });
    expect(ok.status).toBe(200);
    expect(admin.cookie).toMatch(/^jw_session=/);
    expect((await admin.post('/api/setup', { setupCode: SETUP_CODE, username: 'xx', password: 'a-long-password' })).status).toBe(409);
    const me = await admin.get('/api/auth/me');
    expect(me.data.user.role).toBe('admin');
  });

  it('rejects state-changing requests without the CSRF token or from another origin', async () => {
    const noCsrf = await admin.req('PUT', '/api/me/preferences', { appearance: 'dark' }, { csrf: false });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.data.error.code).toBe('csrf');
    const crossSite = await admin.req('PUT', '/api/me/preferences', { appearance: 'dark' }, { headers: { origin: 'https://evil.example' } });
    expect(crossSite.status).toBe(403);
    expect((await admin.put('/api/me/preferences', { appearance: 'dark' })).status).toBe(200);
  });

  it('configures Jellyfin and Seerr through the API without ever returning secrets', async () => {
    const bad = await admin.put('/api/integrations/jellyfin', { config: { url: JF.url }, secrets: { apiKey: 'wrong' } });
    expect(bad.data.test.ok).toBe(false);
    expect(bad.data.test.message).toMatch(/rejected the API key/);
    const good = await admin.put('/api/integrations/jellyfin', { config: { url: `${JF.url}/` }, secrets: { apiKey: JF.key } });
    expect(good.data.test.ok).toBe(true);
    expect(good.data.integration.config.url).toBe(JF.url);
    expect(good.data.integration.secretsSet.apiKey).toBe(true);

    // Leaving the secret empty keeps the stored one.
    const keep = await admin.put('/api/integrations/jellyfin', { config: { url: JF.url }, secrets: { apiKey: '' } });
    expect(keep.data.test.ok).toBe(true);

    const seerr = await admin.put('/api/integrations/seerr', { config: { url: SEERR.url }, secrets: { apiKey: SEERR.key } });
    expect(seerr.data.test.ok).toBe(true);
    expect(seerr.data.test.info.version).toBe('3.5.1');

    const all = await admin.get('/api/integrations');
    expect(all.body).not.toContain(JF.key);
    expect(all.body).not.toContain(SEERR.key);
    const raw = JSON.stringify(ctx.db.prepare('SELECT * FROM integrations').all());
    expect(raw).not.toContain(JF.key);
    expect(raw).not.toContain(SEERR.key);

    const invalidUrl = await admin.put('/api/integrations/seerr', { config: { url: 'http://user:pw@seerr' }, secrets: {} });
    expect(invalidUrl.status).toBe(400);
  });

  it('links a Jellyfin account by verifying credentials and discards the session', async () => {
    expect((await admin.post('/api/connections/jellyfin', { username: 'alice', password: 'nope' })).status).toBe(400);
    const r = await admin.post('/api/connections/jellyfin', { username: 'alice', password: 'alicepw' });
    expect(r.status).toBe(200);
    expect(r.data.linked.userId).toBe(ALICE_JF);
    expect(mocks.state.logouts).toBe(1);
  });

  it('indexes the Jellyfin library and per-user progress, and auto-links Seerr users', async () => {
    const jf = await syncJellyfin(ctx);
    expect(jf.status).toBe('ok');
    expect(jf.stats).toMatchObject({ indexed: 2, users: 1 });
    const sr = await syncSeerr(ctx);
    expect(sr.stats).toMatchObject({ media: 1, linked: 1 });
    const me = await admin.get('/api/auth/me');
    expect(me.data.user.seerr.userId).toBe(1);
  });

  let traktListId: number;
  it('imports a public Trakt list by URL with only the client id', async () => {
    const cfg = await admin.put('/api/integrations/trakt', { config: { clientId: 'c'.repeat(64) }, secrets: {} });
    expect(cfg.data.test.ok).toBe(true);
    const bad = await admin.post('/api/lists/trakt', { mode: 'url', url: 'https://example.com/users/x/lists/y' });
    expect(bad.status).toBe(400);
    const r = await admin.post('/api/lists/trakt', { mode: 'url', url: 'https://trakt.tv/users/sean/lists/mann' });
    expect(r.status).toBe(200);
    expect(r.data.list).toMatchObject({ provider: 'trakt', kind: 'public', name: 'Michael Mann', itemCount: 3, lastStatus: 'ok' });
    traktListId = r.data.list.id;
    expect(mocks.state.traktCalls.some((c) => c.startsWith('/lists/777/items?page=1&limit=250'))).toBe(true);

    // Re-syncing is idempotent.
    const again = await admin.post(`/api/lists/${traktListId}/sync`);
    expect(again.data.result).toMatchObject({ added: 0, removed: 0, total: 3 });
  });

  let uploadListId: number;
  it('imports a Letterboxd CSV, matches titles through Seerr, and queues ambiguous ones for review', async () => {
    const csv = 'Date,Name,Year,Letterboxd URI\n2026-01-01,Heat,1995,https://boxd.it/heat\n2026-01-02,Past Lives,2023,https://boxd.it/past\n2026-01-03,Dune,,https://boxd.it/dune\n';
    const up = await admin.req('POST', '/api/lists/upload', undefined, { raw: multipart({ provider: 'letterboxd' }, { name: 'watchlist.csv', content: csv, type: 'text/csv' }) });
    expect(up.status).toBe(200);
    expect(up.data.lists[0]).toMatchObject({ name: 'Letterboxd Watchlist', kind: 'watchlist', canSync: false, itemCount: 3 });
    uploadListId = up.data.lists[0].id;

    // Imports trigger the match job in the background; join it (single-flight) until nothing is pending.
    while (ctx.matcher.pendingCount() > 0 || ctx.jobs.isRunning('match')) await triggerJob(ctx, 'match', 'manual');
    const counts = Object.fromEntries(
      (ctx.db.prepare('SELECT match_status AS s, COUNT(*) AS n FROM list_items GROUP BY match_status').all() as { s: string; n: number }[]).map((r) => [r.s, r.n]),
    );
    expect(counts).toEqual({ matched: 5, review: 1 }); // 3 Trakt (ids) + Heat + Past Lives; Dune is ambiguous
    const heatRow = ctx.db.prepare("SELECT match_method FROM list_items WHERE source_title = 'Heat' AND source_url LIKE '%boxd%'").get() as { match_method: string };
    expect(heatRow.match_method).toBe('title_year');
    await syncMetadata(ctx);

    const review = await admin.get('/api/review');
    expect(review.data.items).toHaveLength(1);
    expect(review.data.items[0]).toMatchObject({ title: 'Dune', status: 'review' });
    expect(review.data.items[0].candidates.length).toBe(2);
  });

  it('shows one deduplicated catalog with statuses from Jellyfin and Seerr', async () => {
    const cat = await admin.get('/api/catalog');
    const byTitle = Object.fromEntries(cat.data.items.map((i: any) => [i.title, i]));
    expect(cat.data.total).toBe(4); // Heat, Thief, Severance, Past Lives
    expect(byTitle.Heat.lists.map((l: any) => l.provider).sort()).toEqual(['letterboxd', 'trakt']);
    expect(byTitle.Heat).toMatchObject({ availability: 'in_library', viewing: 'watched', stage: 'watched' });
    expect(byTitle.Severance).toMatchObject({ mediaType: 'tv', availability: 'in_library', viewing: 'in_progress', progress: 47 });
    expect(byTitle['Past Lives']).toMatchObject({ availability: 'not_in_library', request: 'not_requested', stage: 'listed' });
    expect(byTitle['Past Lives'].posterUrl).toBe('/api/images/tmdb/w342/past.jpg');

    const filtered = await admin.get('/api/catalog?availability=not_in_library&provider=letterboxd');
    expect(filtered.data.items.map((i: any) => i.title)).toEqual(['Past Lives']);
    const searched = await admin.get('/api/catalog?q=thi');
    expect(searched.data.items.map((i: any) => i.title)).toEqual(['Thief']);
  });

  it('remembers a manual match decision', async () => {
    const review = await admin.get('/api/review');
    const item = review.data.items[0];
    const r = await admin.post(`/api/review/${item.id}`, { tmdbId: 438631, mediaType: 'movie', title: 'Dune', year: 2021 });
    expect(r.data.updated).toBe(1);
    expect((await admin.get('/api/review')).data.items).toHaveLength(0);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM match_resolutions').get()).toEqual({ n: 1 });
  });

  it('requests through Seerr on behalf of the linked user and prevents duplicates', async () => {
    const cat = await admin.get('/api/catalog?q=past');
    const id = cat.data.items[0].id;
    const elig = await admin.get(`/api/titles/${id}/eligibility`);
    expect(elig.data).toMatchObject({ canRequest: true, autoApprove: true });

    const r = await admin.post(`/api/titles/${id}/request`, {});
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ ok: true, state: 'processing' });
    const call = mocks.state.seerrCalls.find((c) => c.method === 'POST' && c.path === '/request');
    expect(call?.apiUser).toBe('1');
    expect(call?.body).toMatchObject({ mediaType: 'movie', mediaId: 666277, is4k: false });

    const dup = await admin.post(`/api/titles/${id}/request`, {});
    expect(dup.status).toBe(409);
    expect(dup.data.error.code).toBe('already_requested');

    const heat = (await admin.get('/api/catalog?q=heat')).data.items[0];
    const heatElig = await admin.get(`/api/titles/${heat.id}/eligibility`);
    expect(heatElig.data).toMatchObject({ canRequest: false, reason: 'already_available' });

    const reqs = await admin.get('/api/requests?filter=active');
    expect(reqs.data.items).toHaveLength(1);
    expect(reqs.data.items[0]).toMatchObject({ state: 'processing', mine: true, origin: 'jellywatcher' });
  });

  it('requests only the missing seasons of a show', async () => {
    const sev = (await admin.get('/api/catalog?q=severance')).data.items[0];
    const elig = await admin.get(`/api/titles/${sev.id}/eligibility`);
    expect(elig.data.seasons.map((s: any) => s.seasonNumber)).toEqual([1, 2]);
    const r = await admin.post(`/api/titles/${sev.id}/request`, { seasons: [2, 99] });
    expect(r.status).toBe(200);
    const call = mocks.state.seerrCalls.filter((c) => c.method === 'POST' && c.path === '/request').pop();
    expect(call?.body).toMatchObject({ mediaType: 'tv', mediaId: 95396, seasons: [2], tvdbId: 371980 });
  });

  it('isolates users: members cannot see other people’s lists or administer integrations', async () => {
    const created = await admin.post('/api/admin/users', { username: 'bob', password: 'bob-password-1', role: 'user' });
    expect(created.status).toBe(200);
    const bob = new Client(app);
    expect((await bob.login('bob', 'wrong-password')).status).toBe(401);
    expect((await bob.login('bob', 'bob-password-1')).status).toBe(200);

    expect((await bob.get(`/api/lists/${traktListId}`)).status).toBe(404);
    expect((await bob.get(`/api/catalog?listId=${uploadListId}`)).status).toBe(404);
    expect((await bob.del(`/api/lists/${uploadListId}`)).status).toBe(404);
    expect((await bob.get('/api/catalog')).data.total).toBe(0);
    expect((await bob.put('/api/integrations/seerr', { config: { url: SEERR.url }, secrets: {} })).status).toBe(403);
    expect((await bob.get('/api/admin/users')).status).toBe(403);
    const ints = await bob.get('/api/integrations');
    expect(ints.data.integrations[0].config).toBeUndefined();
    // Bob is not linked to Seerr, so requesting is refused with an explanation.
    const anyTitle = ctx.db.prepare('SELECT id FROM titles WHERE tmdb_id = 11524').get() as { id: number };
    const elig = await bob.get(`/api/titles/${anyTitle.id}/eligibility`);
    expect(elig.data).toMatchObject({ canRequest: false, reason: 'seerr_not_linked' });
    expect((await bob.get('/api/requests?scope=all')).data.items).toHaveLength(0);
  });

  it('keeps the last known library when Jellyfin is down and marks it stale', async () => {
    mocks.state.jellyfinDown = true;
    await expect(syncJellyfin(ctx)).rejects.toMatchObject({ kind: 'unavailable' });
    mocks.state.jellyfinDown = false;
    expect(ctx.integrations.get('jellyfin').status).toBe('error');
    const heat = (await admin.get('/api/catalog?q=heat')).data.items[0];
    expect(heat.availability).toBe('in_library');
    expect(heat.stale).toBe(true);
    const detail = await admin.get(`/api/titles/${heat.id}`);
    expect(detail.data.status.availability.stale).toBe(true);
    expect(detail.data.links.jellyfin).toContain('/web/#/details?id=');
    await syncJellyfin(ctx);
    expect(ctx.integrations.get('jellyfin').status).toBe('ok');
  });

  it('authenticates webhooks with the shared token', async () => {
    expect((await admin.req('POST', '/api/webhooks/seerr', {}, { csrf: false })).status).toBe(401);
    const token = (await admin.get('/api/integrations/webhook')).data.token;
    const ok = await new Client(app).req('POST', '/api/webhooks/seerr', { notification_type: 'MEDIA_AVAILABLE' }, { headers: { authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
  });

  it('serves proxied TMDb images only for whitelisted sizes and file names', async () => {
    expect((await admin.get('/api/images/tmdb/w342/past.jpg')).status).toBe(200);
    expect((await admin.get('/api/images/tmdb/original/past.jpg')).status).toBe(400);
    expect((await admin.get('/api/images/tmdb/w342/..%2F..%2Fetc%2Fpasswd')).status).toBe(400);
    expect((await new Client(app).get('/api/images/tmdb/w342/past.jpg')).status).toBe(401);
  });

  it('never leaks secrets in diagnostics or sync history', async () => {
    const diag = await admin.get('/api/admin/diagnostics');
    const hist = await admin.get('/api/admin/sync/history');
    for (const body of [diag.body, hist.body]) {
      expect(body).not.toContain(JF.key);
      expect(body).not.toContain(SEERR.key);
    }
  });
});
