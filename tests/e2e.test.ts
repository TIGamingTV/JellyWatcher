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
import { ALICE_JF, BOB_JF, HEAT_JF, IMDB_HEADER_LIST, IMDB_LIST, JF, SEERR, SEV_JF, createMocks } from './helpers/mocks';
import { mirrorPayload } from '../server/services/mirrors';

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
    // ...but only for the same server: the stored key is never sent to a new address.
    const elsewhere = { config: { url: 'http://attacker.example:8096' }, secrets: { apiKey: '' } };
    expect((await admin.put('/api/integrations/jellyfin', elsewhere)).data.error.code).toBe('secret_required');
    expect((await admin.post('/api/integrations/jellyfin/test', elsewhere)).data.test).toMatchObject({ ok: false, message: 'Enter an API key.' });
    expect(ctx.integrations.get('jellyfin').config.url).toBe(JF.url);

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

  let imdbListId: number;
  it('adds a public IMDb list by link, keeping its order and its episodes', async () => {
    expect((await admin.post('/api/lists/link', { url: 'https://example.com/list/ls020816781/' })).status).toBe(400);
    expect((await admin.post('/api/lists/link', { url: 'https://www.imdb.com/list/ls000000001/' })).status).toBe(404); // private
    const r = await admin.post('/api/lists/link', { url: 'https://www.imdb.com/de/list/ls020816781/?ref_=x' });
    expect(r.status).toBe(200);
    expect(r.data.list).toMatchObject({ provider: 'imdb', kind: 'public', name: 'Mann Timeline', canSync: true, itemCount: 4, timeline: true });
    imdbListId = r.data.list.id;
    expect(mocks.state.imdbCalls.filter((c) => c.id === IMDB_LIST).map((c) => c.after)).toEqual([null, 'c2']);

    while (ctx.matcher.pendingCount() > 0 || ctx.jobs.isRunning('match')) await triggerJob(ctx, 'match', 'manual');
    await syncMetadata(ctx);
    await syncJellyfin(ctx); // reads Severance's episodes now that it is on a list

    const tl = await admin.get(`/api/lists/${imdbListId}/timeline`);
    expect(tl.status).toBe(200);
    expect(tl.data.entries.map((e: any) => [e.position, e.kind, e.title?.title, e.season, e.episode])).toEqual([
      [1, 'movie', 'Heat', null, null],
      [2, 'episode', 'Severance', 1, 1],
      [3, 'movie', 'Thief', null, null],
      [4, 'show', 'Severance', null, null],
    ]);
    expect(tl.data.entries.map((e: any) => e.state)).toEqual(['watched', 'watched', 'unwatched', 'in_progress']);
    expect(tl.data.entries[3]).toMatchObject({ episodes: 19, seasons: 2, watchedEpisodes: 9, runtime: 950 });
    expect(tl.data.nextIndex).toBe(2);
    // 170 (Heat) + 57 (episode) + 123 (Thief) + 19 × 50 (Severance)
    expect(tl.data.summary).toMatchObject({ entries: 4, films: 2, shows: 1, seasons: 2, episodes: 20, totalMinutes: 1300, watchedMinutes: 677, remainingMinutes: 623 });

    // Re-sync through the normal path is idempotent and keeps the order.
    const again = await admin.post(`/api/lists/${imdbListId}/sync`);
    expect(again.data.result).toMatchObject({ added: 0, removed: 0, total: 4 });
  });

  it('treats a show listed before its own episodes as their header', async () => {
    const r = await admin.post('/api/lists/link', { url: `https://www.imdb.com/list/${IMDB_HEADER_LIST}/` });
    expect(r.status).toBe(200);
    const id = r.data.list.id;
    while (ctx.matcher.pendingCount() > 0 || ctx.jobs.isRunning('match')) await triggerJob(ctx, 'match', 'manual');
    const tl = (await admin.get(`/api/lists/${id}/timeline`)).data;
    expect(tl.entries.map((e: any) => [e.kind, e.header, e.parts, e.season, e.episode])).toEqual([
      ['show', true, 2, null, null],
      ['episode', false, null, 1, 1],
      ['movie', false, null, null, null],
      ['episode', false, null, 1, 2],
    ]);
    expect(tl.entries[0]).toMatchObject({ runtime: null, episodes: null, watchedMinutes: 0 });
    // The whole show's 19 episodes are not counted on top of the two listed ones.
    expect(tl.summary).toMatchObject({ entries: 3, headers: 1, films: 1, shows: 0, episodes: 2, totalMinutes: 57 + 170 + 57 });
    expect(tl.nextIndex).not.toBe(0);

    // In Jellyfin the episodes keep their places around the movie; the header is not added.
    expect((await admin.put(`/api/lists/${id}/mirror`, { mode: 'playlist' })).status).toBe(200);
    const mirrored = mirrorPayload(ctx).lists.find((l) => l.listId === id)!;
    expect(mirrored.entries.map((e) => [e.kind, e.season, e.episode])).toEqual([
      ['episode', 1, 1],
      ['movie', null, null],
      ['episode', 1, 2],
    ]);
    expect((await admin.del(`/api/lists/${id}`)).status).toBe(200);
  });

  it('keeps episodes from an IMDb CSV export by looking up their show', async () => {
    const csv = [
      'Position,Const,Title,URL,Title Type,Runtime (mins),Year',
      '1,tt0113277,Heat,https://www.imdb.com/title/tt0113277/,Movie,170,1995',
      '2,tt11650330,Half Loop,https://www.imdb.com/title/tt11650330/,TV Episode,57,2022',
      '3,tt0000009,Unknown Episode,https://www.imdb.com/title/tt0000009/,TV Episode,30,2020',
      '4,tt0083190,Thief,https://www.imdb.com/title/tt0083190/,Movie,123,1981',
    ].join('\n');
    const upload = () => admin.req('POST', '/api/lists/upload', undefined, { raw: multipart({ provider: 'imdb' }, { name: 'mann-order.csv', content: csv, type: 'text/csv' }) });

    mocks.state.imdbDown = true;
    const down = await upload();
    mocks.state.imdbDown = false;
    expect(down.status).toBe(502);
    expect(down.data.error.code).toBe('imdb_unavailable');
    expect((await admin.get('/api/lists')).data.lists.some((l: any) => l.name === 'mann order')).toBe(false);

    mocks.state.imdbTitleCalls.length = 0;
    const up = await upload();
    expect(up.status).toBe(200);
    expect(mocks.state.imdbTitleCalls).toEqual([['tt11650330', 'tt0000009']]);
    expect(up.data.lists[0].applied).toMatchObject({ added: 3, skipped: 1 });
    const id = up.data.lists[0].id;
    while (ctx.matcher.pendingCount() > 0 || ctx.jobs.isRunning('match')) await triggerJob(ctx, 'match', 'manual');
    const tl = (await admin.get(`/api/lists/${id}/timeline`)).data;
    expect(tl.entries.map((e: any) => [e.kind, e.title?.title, e.season, e.episode, e.episodeTitle])).toEqual([
      ['movie', 'Heat', null, null, null],
      ['episode', 'Severance', 1, 2, 'Half Loop'],
      ['movie', 'Thief', null, null, null],
    ]);
    expect(tl.entries[1].sourceUrl).toBe('https://www.imdb.com/title/tt11650330/');
    // A new export of the same list updates it in place.
    const again = await admin.req('POST', '/api/lists/upload', undefined, { raw: multipart({ provider: 'imdb', replaceListId: String(id) }, { name: 'mann-order.csv', content: csv, type: 'text/csv' }) });
    expect(again.data.lists[0].applied).toMatchObject({ added: 0, removed: 0, total: 3 });
    expect((await admin.del(`/api/lists/${id}`)).status).toBe(200);
  });

  it('shows the next entry of each list on Home, deduplicated across lists', async () => {
    const home = await admin.get('/api/home');
    expect(home.data.continueWatching).toBeUndefined();
    const first = home.data.upNext[0];
    expect(first).toMatchObject({ timeline: true, position: 3, of: 4, action: 'request' });
    expect(first.list.id).toBe(imdbListId);
    expect(first.entry.title.title).toBe('Thief');
    expect(first.lists.map((l: any) => l.provider).sort()).toEqual(['imdb', 'trakt']); // also next on the Trakt list
    const titles = home.data.upNext.map((u: any) => u.entry.title.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('keeps titles watched after they are deleted from the library', async () => {
    mocks.state.jellyfinRemoved = new Set([HEAT_JF, SEV_JF]);
    mocks.state.seerrMedia.delete('movie:949');
    await syncJellyfin(ctx);
    await syncSeerr(ctx);
    const heat = (await admin.get('/api/catalog?q=heat')).data.items[0];
    expect(heat).toMatchObject({ availability: 'not_in_library', viewing: 'watched', stage: 'watched' });
    const sev = (await admin.get('/api/catalog?q=severance')).data.items[0];
    expect(sev).toMatchObject({ availability: 'not_in_library', viewing: 'in_progress' });
    const detail = await admin.get(`/api/titles/${heat.id}`);
    expect(detail.data.status.viewing.detail).toMatch(/No longer in the library/);
    const tl = await admin.get(`/api/lists/${imdbListId}/timeline`);
    expect(tl.data.entries.map((e: any) => e.state)).toEqual(['watched', 'watched', 'unwatched', 'in_progress']);
    expect(tl.data.entries[3].watchedEpisodes).toBe(9);

    mocks.state.jellyfinRemoved = new Set();
    mocks.state.seerrMedia.set('movie:949', { id: 1, tmdbId: 949, mediaType: 'movie', status: 5 });
    await syncJellyfin(ctx);
    await syncSeerr(ctx);
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
    // Bob sees that a title was requested, not by whom.
    const requested = ctx.db.prepare('SELECT title_id AS id FROM requests LIMIT 1').get() as { id: number };
    const forBob = (await bob.get(`/api/titles/${requested.id}`)).data;
    expect(forBob.requests.length).toBeGreaterThan(0);
    expect(forBob.requests.every((r: any) => r.requestedBy === null && r.userId === undefined && r.mine === false)).toBe(true);
    expect(forBob.status.request.requestedBy).toBeNull();
    expect((await admin.get(`/api/titles/${requested.id}`)).data.requests[0].requestedBy).not.toBeNull();
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
    // Jellyfin artwork only for items of the indexed library.
    expect((await admin.get(`/api/images/jellyfin/${HEAT_JF}?tag=p1`)).status).toBe(200);
    expect((await admin.get(`/api/images/jellyfin/${'a'.repeat(32)}`)).status).toBe(404);
  });

  it('never leaks secrets in diagnostics or sync history', async () => {
    const diag = await admin.get('/api/admin/diagnostics');
    const hist = await admin.get('/api/admin/sync/history');
    for (const body of [diag.body, hist.body]) {
      expect(body).not.toContain(JF.key);
      expect(body).not.toContain(SEERR.key);
    }
  });

  it('lets the Jellyfin plugin act for linked people with its key, and nothing else', async () => {
    const plugin = (method: string, url: string, headers: Record<string, string>, body?: unknown) => new Client(app).req(method, url, body, { headers });
    expect((await admin.get('/api/integrations/jellyfin-plugin')).data).toMatchObject({ enabled: false, key: null, lastSeen: null });
    // Off until an administrator creates a key.
    expect((await plugin('GET', '/api/plugin/status', { 'x-jw-plugin-key': 'jwp_guess' })).status).toBe(401);
    const on = await admin.post('/api/integrations/jellyfin-plugin');
    expect(on.data.enabled).toBe(true);
    expect(on.data.repositoryUrl).toMatch(/jellyfin-plugin\/manifest\.json$/);
    const key: string = on.data.key;
    const h = (user?: string, extra: Record<string, string> = {}) => ({
      'x-jw-plugin-key': key,
      'x-jw-plugin-version': '0.5.0.0',
      'x-jw-jellyfin-server': 'srv1',
      ...(user ? { 'x-jw-jellyfin-user': user, 'x-jw-jellyfin-name': 'alice' } : {}),
      ...extra,
    });

    expect((await plugin('GET', '/api/plugin/status', h())).data).toMatchObject({ ok: true, jellyfin: { ready: true, serverId: 'srv1' } });
    expect((await plugin('GET', '/api/plugin/status', {})).status).toBe(401);
    expect((await plugin('GET', '/api/lists', h(ALICE_JF, { 'x-jw-plugin-key': `${key}x` }))).status).toBe(401);
    expect((await plugin('GET', '/api/lists', h())).data.error.code).toBe('plugin_user');

    // Jellyfin ids with dashes match too.
    const dashed = ALICE_JF.replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
    const lists = await plugin('GET', '/api/lists', h(dashed));
    expect(lists.status).toBe(200);
    expect(lists.data.lists.map((l: any) => l.id)).toContain(imdbListId);
    const boot = await plugin('GET', '/api/plugin/bootstrap', h(ALICE_JF));
    expect(boot.data).toMatchObject({ user: { username: 'admin' }, seerr: { available: true, linked: true }, trakt: { connected: false } });

    const tl = await plugin('GET', `/api/lists/${imdbListId}/timeline`, h(ALICE_JF));
    expect(tl.data.entries.map((e: any) => e.jellyfinItemId)).toEqual([HEAT_JF, 'e101'.padEnd(32, '0'), null, SEV_JF]);

    // Writes need no CSRF token or cookie.
    const thief = tl.data.entries[2].title.id;
    expect((await plugin('PUT', `/api/titles/${thief}/skipped`, h(ALICE_JF), { skipped: true })).data).toMatchObject({ ok: true, skipped: true });
    expect((await plugin('PUT', `/api/titles/${thief}/skipped`, h(ALICE_JF), { skipped: false })).data).toMatchObject({ ok: true, skipped: false });
    expect((await plugin('GET', `/api/titles/${thief}/eligibility`, h(ALICE_JF))).data.canRequest).toBe(true);

    // Only the Watchlists page's routes, never administration (Alice is an administrator here).
    for (const [m, u] of [
      ['GET', '/api/admin/users'],
      ['GET', '/api/integrations'],
      ['GET', '/api/integrations/jellyfin-plugin'],
      ['POST', '/api/integrations/jellyfin-plugin'],
      ['GET', '/api/auth/me'],
      ['GET', '/api/admin/backup'],
      ['DELETE', `/api/lists/${imdbListId}`],
      ['GET', '/api/images/jellyfin/' + HEAT_JF],
    ] as const) {
      expect((await plugin(m, u, h(ALICE_JF))).status, `${m} ${u}`).toBe(403);
    }
    // A session cookie does not widen a plugin request.
    expect((await admin.req('GET', '/api/admin/users', undefined, { headers: h(ALICE_JF) })).status).toBe(403);
    // Public TMDb artwork works with the key alone (for <img> tags), but only for known titles.
    expect((await plugin('GET', '/api/images/tmdb/w342/past.jpg', h())).status).toBe(200);
    expect((await plugin('GET', '/api/images/tmdb/w185/heat.jpg', h())).status).toBe(200);
    expect((await plugin('GET', '/api/images/tmdb/w185/not-a-poster-here.jpg', h())).status).toBe(404);
    expect((await admin.get('/api/images/tmdb/w185/not-a-poster-here.jpg')).status).toBe(200);

    // Lists shown in Jellyfin: chosen per list, handed to the plugin in list order, status reported back.
    expect((await admin.get('/api/auth/me')).data.services.jellyfinPlugin).toBe(true);
    expect((await plugin('GET', '/api/plugin/mirrors', h())).data.lists).toEqual([]);
    expect((await admin.get('/api/plugin/mirrors')).status).toBe(401);
    expect((await plugin('PUT', `/api/lists/${imdbListId}/mirror`, h(ALICE_JF), { mode: 'shelf' })).status).toBe(400);
    const on1 = await plugin('PUT', `/api/lists/${imdbListId}/mirror`, h(ALICE_JF), { mode: 'collection' });
    expect(on1.data.list.jellyfin).toMatchObject({ mode: 'collection', synced: false, applied: 0 });
    const payload = (await plugin('GET', '/api/plugin/mirrors', h())).data;
    expect(payload.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.lists).toHaveLength(1);
    expect(payload.lists[0]).toMatchObject({ listId: imdbListId, mode: 'collection', owner: ALICE_JF, name: expect.any(String) });
    const mirrored = payload.lists[0].entries;
    expect(mirrored.map((e: any) => e.jellyfinItemId)).toEqual([HEAT_JF, 'e101'.padEnd(32, '0'), null, SEV_JF]);
    expect(mirrored.map((e: any) => e.kind)).toEqual(tl.data.entries.map((e: any) => e.kind));
    expect(mirrored[0]).toMatchObject({ mediaType: 'movie', tmdbId: expect.any(String), jellyfinIds: [HEAT_JF] });
    // "Not Watching" entries are left out.
    await plugin('PUT', `/api/titles/${thief}/skipped`, h(ALICE_JF), { skipped: true });
    expect((await plugin('GET', '/api/plugin/mirrors', h())).data.lists[0].entries).toHaveLength(3);
    await plugin('PUT', `/api/titles/${thief}/skipped`, h(ALICE_JF), { skipped: false });

    const report = (results: unknown[]) => plugin('POST', '/api/plugin/mirrors/report', h(), { results });
    const row = (over: Record<string, unknown> = {}) => ({ listId: imdbListId, mode: 'collection', jellyfinId: 'C'.repeat(32), applied: 3, missing: 1, error: null, ...over });
    expect((await report([row(), row({ listId: 999999 })])).data.saved).toBe(1);
    expect((await report([row({ jellyfinId: '../x' })])).status).toBe(400);
    expect((await admin.get(`/api/lists/${imdbListId}`)).data.list.jellyfin).toMatchObject({ mode: 'collection', synced: true, applied: 3, missing: 1, jellyfinId: 'c'.repeat(32), error: null });
    // Switching to a playlist starts over; a late report for the collection is ignored.
    expect((await admin.put(`/api/lists/${imdbListId}/mirror`, { mode: 'playlist' })).data.list.jellyfin).toMatchObject({ mode: 'playlist', synced: false });
    expect((await report([row()])).data.saved).toBe(0);
    expect((await report([row({ mode: 'playlist', error: 'Your Jellyfin account may not create collections.' })])).data.saved).toBe(1);
    expect((await admin.get(`/api/lists/${imdbListId}`)).data.list.jellyfin.error).toMatch(/may not/);
    // Off: the list leaves the payload, so the plugin deletes what it made.
    expect((await plugin('PUT', `/api/lists/${imdbListId}/mirror`, h(ALICE_JF), { mode: null })).data.list.jellyfin).toBeNull();
    expect((await plugin('GET', '/api/plugin/mirrors', h())).data.lists).toEqual([]);

    // Unknown Jellyfin users follow the sign-in rules: refused, or created when allowed.
    const stranger = 'f'.repeat(32);
    expect((await plugin('GET', '/api/lists', h(stranger))).data.error.code).toBe('not_invited');
    await admin.put('/api/admin/settings', { 'auth.jellyfinAutoCreate': true });
    const created = await plugin('GET', '/api/plugin/bootstrap', h(stranger, { 'x-jw-jellyfin-name': encodeURIComponent('Zoë Example') }));
    expect(created.data.user).toMatchObject({ username: 'ZoExample', displayName: 'Zoë Example' });
    const roleOf = (username: string) => (ctx.db.prepare('SELECT role FROM users WHERE username = ?').get(username) as { role: string }).role;
    expect(roleOf('ZoExample')).toBe('user');

    // Bob opens the page in Jellyfin: his own new account (the local "bob" is someone else to
    // JellyWatcher), never Alice's lists, and Seerr sees him as his own Seerr user.
    const asBob = (method: string, url: string, body?: unknown) => plugin(method, url, h(BOB_JF, { 'x-jw-jellyfin-name': 'bob' }), body);
    const bobBoot = await asBob('GET', '/api/plugin/bootstrap');
    expect(bobBoot.data.user).toMatchObject({ username: 'bob-jf' });
    expect(roleOf('bob-jf')).toBe('user');
    expect((await asBob('GET', '/api/lists')).data.lists).toEqual([]);
    for (const [m, u, b] of [
      ['GET', `/api/lists/${imdbListId}`],
      ['GET', `/api/lists/${imdbListId}/timeline`],
      ['POST', `/api/lists/${imdbListId}/sync`, {}],
      ['PUT', `/api/lists/${imdbListId}/mirror`, { mode: 'playlist' }],
    ] as const) {
      expect((await asBob(m, u, b)).status, `${m} ${u}`).toBe(404);
    }
    expect((await admin.get(`/api/lists/${imdbListId}`)).data.list.jellyfin).toBeNull();
    await syncSeerr(ctx); // links bob-jf to Seerr user 2 by his Jellyfin id
    mocks.state.seerrCalls.length = 0;
    expect((await asBob('GET', `/api/titles/${thief}/eligibility`)).status).toBe(200);
    expect(mocks.state.seerrCalls.filter((c) => c.path.startsWith('/movie/')).map((c) => c.apiUser)).toEqual(['2']);
    mocks.state.seerrCalls.length = 0;
    expect((await plugin('GET', `/api/titles/${thief}/eligibility`, h(ALICE_JF))).status).toBe(200);
    expect(mocks.state.seerrCalls.filter((c) => c.path.startsWith('/movie/')).map((c) => c.apiUser)).toEqual(['1']);
    // Expanding a show on the Watchlists page: the episode guide with the person's own state.
    const sevId = (ctx.db.prepare('SELECT id FROM titles WHERE tmdb_id = 95396').get() as { id: number }).id;
    const guide = await plugin('GET', `/api/titles/${sevId}/episodes`, h(ALICE_JF));
    expect(guide.status).toBe(200);
    expect(guide.data.seasons[0]).toMatchObject({ season: 1, watched: 9 });
    expect((await plugin('GET', `/api/titles/${sevId}`, h(ALICE_JF))).status).toBe(403);
    ctx.db.prepare('UPDATE titles SET episodes_fetched_at = NULL').run();
    // One Seerr user, one account: linking it to the local "bob" too is refused.
    const localBob = (await admin.get('/api/admin/users')).data.users.find((x: any) => x.username === 'bob');
    const taken = await admin.patch(`/api/admin/users/${localBob.id}`, { seerrUserId: 2 });
    expect(taken.status).toBe(409);
    expect(taken.data.error.code).toBe('seerr_user_taken');
    await admin.put('/api/admin/settings', { 'auth.jellyfinAutoCreate': false });

    // Jellyfin user ids only count on the Jellyfin server JellyWatcher is connected to.
    const elsewhere = await plugin('GET', '/api/lists', h(ALICE_JF, { 'x-jw-jellyfin-server': 'f'.repeat(32) }));
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.data.error.code).toBe('plugin_server');
    expect((await plugin('GET', '/api/lists', h(ALICE_JF, { 'x-jw-jellyfin-server': 'SRV1' }))).status).toBe(200);

    const view = (await admin.get('/api/integrations/jellyfin-plugin')).data;
    expect(view.lastSeen).toMatchObject({ version: '0.5.0.0', jellyfinServerId: 'srv1' });
    expect(view.key).toBe(key);

    // A new key stops the old one; turning it off stops all.
    const next = (await admin.post('/api/integrations/jellyfin-plugin')).data.key;
    expect(next).not.toBe(key);
    expect((await plugin('GET', '/api/lists', h(ALICE_JF))).status).toBe(401);
    expect((await plugin('GET', '/api/lists', h(ALICE_JF, { 'x-jw-plugin-key': next }))).status).toBe(200);
    expect((await admin.del('/api/integrations/jellyfin-plugin')).data.enabled).toBe(false);
    expect((await plugin('GET', '/api/lists', h(ALICE_JF, { 'x-jw-plugin-key': next }))).status).toBe(401);
  });

  it('marks a movie as watched on a chosen date and takes the mark back', async () => {
    const thief = (await admin.get('/api/catalog?q=thief')).data.items[0];
    expect(thief.viewing).not.toBe('watched');
    expect((await admin.put(`/api/titles/${thief.id}/watched`, { watched: true, watchedAt: '2999-01-01' })).status).toBe(400);
    expect((await admin.put(`/api/titles/${thief.id}/watched`, { watched: true, season: 1 })).status).toBe(400);

    const r = await admin.put(`/api/titles/${thief.id}/watched`, { watched: true, watchedAt: '2026-05-01' });
    expect(r.status).toBe(200);
    expect(r.data.status.viewing).toMatchObject({ state: 'watched', source: 'Marked by you' });
    expect(r.data.watch.manualAt).toMatch(/^2026-05-01/);
    expect((await admin.get('/api/catalog?q=thief')).data.items[0]).toMatchObject({ viewing: 'watched', stage: 'watched' });
    const tl = await admin.get(`/api/lists/${imdbListId}/timeline`);
    expect(tl.data.entries[2]).toMatchObject({ state: 'watched' });
    expect(tl.data.entries[2].manualAt).toMatch(/^2026-05-01/);
    expect(tl.data.nextIndex).toBe(3);

    const undo = await admin.put(`/api/titles/${thief.id}/watched`, { watched: false });
    expect(undo.data.status.viewing.state).not.toBe('watched');
    expect(undo.data.watch.manualAt).toBeNull();
  });

  it('marks single episodes and whole seasons, and splits a season mark when one episode is unmarked', async () => {
    const sev = (await admin.get('/api/catalog?q=severance')).data.items[0];
    const entry = async () => (await admin.get(`/api/lists/${imdbListId}/timeline`)).data.entries[3];
    expect((await entry()).watchedEpisodes).toBe(9);

    const one = await admin.put(`/api/titles/${sev.id}/watched`, { watched: true, season: 2, episode: 1, watchedAt: '2026-06-01' });
    expect(one.status).toBe(200);
    const s2 = one.data.watch.seasons.find((s: any) => s.season === 2);
    expect(s2).toMatchObject({ season: 2, episodes: 10, watched: 1 });
    expect(s2.list[0]).toMatchObject({ episode: 1, watched: true, source: 'manual' });
    expect(one.data.watch.seasons.find((s: any) => s.season === 1).list[0]).toMatchObject({ watched: true, source: 'jellyfin' });
    expect((await entry()).watchedEpisodes).toBe(10);

    const season = await admin.put(`/api/titles/${sev.id}/watched`, { watched: true, season: 2 });
    expect(season.data.status.viewing.state).toBe('watched');
    expect(await entry()).toMatchObject({ state: 'watched', watchedEpisodes: 19 });

    await admin.put(`/api/titles/${sev.id}/watched`, { watched: false, season: 2, episode: 3 });
    const marks = ctx.db.prepare('SELECT season, episode FROM manual_watches WHERE title_id = ? ORDER BY episode').all(sev.id) as { season: number; episode: number }[];
    expect(marks.map((m) => m.episode)).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 10]);
    expect(await entry()).toMatchObject({ state: 'in_progress', watchedEpisodes: 18 });

    await admin.put(`/api/titles/${sev.id}/watched`, { watched: false });
    expect((await entry()).watchedEpisodes).toBe(9);
  });

  it('keeps a personal order across syncs and can go back to the source order', async () => {
    const before = (await admin.get(`/api/lists/${imdbListId}/timeline`)).data.entries;
    const reversed = [...before].reverse().map((e: any) => e.itemId);
    expect((await new Client(app).req('PUT', `/api/lists/${imdbListId}/order`, { itemIds: reversed })).status).toBe(401);
    const r = await admin.put(`/api/lists/${imdbListId}/order`, { itemIds: reversed });
    expect(r.status).toBe(200);
    expect(r.data.list.customOrder).toBe(true);
    const order = async () => (await admin.get(`/api/lists/${imdbListId}/timeline`)).data.entries.map((e: any) => [e.position, e.itemId]);
    expect(await order()).toEqual(reversed.map((id, i) => [i + 1, id]));

    await admin.post(`/api/lists/${imdbListId}/sync`);
    expect((await order()).map((x: any) => x[1])).toEqual(reversed);

    const reset = await admin.del(`/api/lists/${imdbListId}/order`);
    expect(reset.data.list.customOrder).toBe(false);
    expect((await order()).map((x: any) => x[1])).toEqual(before.map((e: any) => e.itemId));
  });

  it('skips an entry ("Not Watching") so Up Next moves on, and takes it back', async () => {
    const thief = (ctx.db.prepare('SELECT id FROM titles WHERE tmdb_id = 11524').get() as { id: number }).id;
    const timeline = async () => (await admin.get(`/api/lists/${imdbListId}/timeline`)).data;
    const before = await timeline();
    expect(before.nextIndex).toBe(2);
    expect(before.entries[2]).toMatchObject({ skipped: false });

    expect((await admin.put(`/api/titles/${thief}/skipped`, { skipped: true, season: 1 })).status).toBe(400); // movies have no seasons
    expect((await new Client(app).req('PUT', `/api/titles/${thief}/skipped`, { skipped: true })).status).toBe(401);
    expect((await admin.put(`/api/titles/${thief}/skipped`, { skipped: true })).status).toBe(200);

    const after = await timeline();
    expect(after.entries[2]).toMatchObject({ skipped: true, state: 'unwatched' });
    expect(after.nextIndex).toBe(3);
    expect(after.summary).toMatchObject({ skippedEntries: 1, totalMinutes: before.summary.totalMinutes - 123 });
    const home = await admin.get('/api/home');
    const next = home.data.upNext.find((u: any) => u.list.id === imdbListId);
    expect(next.entry.title.title).toBe('Severance');

    // Watched wins over skipped.
    const heat = (ctx.db.prepare('SELECT id FROM titles WHERE tmdb_id = 949').get() as { id: number }).id;
    await admin.put(`/api/titles/${heat}/skipped`, { skipped: true });
    expect((await timeline()).entries[0]).toMatchObject({ state: 'watched', skipped: false });
    await admin.put(`/api/titles/${heat}/skipped`, { skipped: false });

    // A season skip covers that season's episode entries; unskipping the episode takes it back.
    const sev = (ctx.db.prepare('SELECT id FROM titles WHERE tmdb_id = 95396').get() as { id: number }).id;
    expect((await timeline()).entries[3]).toMatchObject({ kind: 'show', state: 'in_progress', skippedEpisodes: 0, percent: 47 });
    await admin.put(`/api/titles/${sev}/skipped`, { skipped: true, season: 2 });
    // The whole show is not skipped, but its skipped season no longer counts: season 1 is all that is left.
    const sevSkipped = (await timeline()).entries[3];
    expect(sevSkipped).toMatchObject({ skipped: false, state: 'watched', episodes: 19, skippedEpisodes: 10, percent: 100 });
    // Taking back one episode keeps the rest of the season skipped.
    await admin.put(`/api/titles/${sev}/skipped`, { skipped: false, season: 2, episode: 4 });
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM skipped_entries WHERE title_id = ? AND episode > 0').get(sev)).toEqual({ n: 9 });
    expect((await timeline()).entries[3]).toMatchObject({ state: 'in_progress', skippedEpisodes: 9, percent: 90 });
    await admin.put(`/api/titles/${sev}/skipped`, { skipped: false, season: 2 });
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM skipped_entries WHERE title_id = ?').get(sev)).toEqual({ n: 0 });

    await admin.put(`/api/titles/${thief}/skipped`, { skipped: false });
    expect((await timeline()).nextIndex).toBe(2);
  });

  it('lists the episodes of a show by season, with watched and "Not Watching" state', async () => {
    const sev = (ctx.db.prepare('SELECT id FROM titles WHERE tmdb_id = 95396').get() as { id: number }).id;
    const heat = (ctx.db.prepare('SELECT id FROM titles WHERE tmdb_id = 949').get() as { id: number }).id;
    mocks.state.seerrCalls.length = 0;
    const r = await admin.get(`/api/titles/${sev}/episodes`);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ titleId: sev, source: 'seerr', skipped: false });
    expect(r.data.seasons.map((s: any) => [s.season, s.year, s.episodes, s.watched, s.skipped])).toEqual([
      [1, 2022, 9, 9, 0],
      [2, 2025, 10, 0, 0],
      [0, 2022, 1, 0, 0],
    ]);
    // Seerr has no runtimes: the episode's own length in Jellyfin fills in.
    expect(r.data.seasons[1].list[0]).toMatchObject({ episode: 1, name: 'Hello, Ms. Cobel', airDate: '2025-01-17', aired: true, runtime: 50, watched: false, skipped: false, inLibrary: true });
    expect(r.data.seasons[1].list[0].jellyfinItemId).toMatch(/^e201/);
    expect(r.data.seasons[0].list[0]).toMatchObject({ watched: true, source: 'jellyfin' });
    expect(r.data.seasons[1].runtime).toBe(500);
    expect(r.data.seasons[2].list[0]).toMatchObject({ name: 'Inside Lumon', inLibrary: false, aired: true });
    expect(mocks.state.seerrCalls.filter((c) => c.path.includes('/season/')).map((c) => c.path).sort()).toEqual(['/tv/95396/season/0', '/tv/95396/season/1', '/tv/95396/season/2']);

    // Kept for a week: opening it again does not ask Seerr.
    mocks.state.seerrCalls.length = 0;
    await admin.put(`/api/titles/${sev}/skipped`, { skipped: true, season: 2, episode: 3 });
    const g = (await admin.get(`/api/titles/${sev}/episodes`)).data;
    expect(mocks.state.seerrCalls.filter((c) => c.path.includes('/season/'))).toEqual([]);
    expect(g.seasons[1]).toMatchObject({ skipped: 1, runtime: 450, seasonSkipped: false });
    expect(g.seasons[1].list[2].skipped).toBe(true);
    await admin.put(`/api/titles/${sev}/skipped`, { skipped: true, season: 2 });
    expect((await admin.get(`/api/titles/${sev}/episodes`)).data.seasons[1]).toMatchObject({ skipped: 10, seasonSkipped: true, runtime: null });
    await admin.put(`/api/titles/${sev}/skipped`, { skipped: false, season: 2 });

    // A watched episode is never skipped, and the guide follows marks.
    await admin.put(`/api/titles/${sev}/watched`, { watched: true, season: 2, episode: 1 });
    expect((await admin.get(`/api/titles/${sev}/episodes`)).data.seasons[1]).toMatchObject({ watched: 1, skipped: 0 });
    await admin.put(`/api/titles/${sev}/watched`, { watched: false, season: 2, episode: 1 });

    expect((await admin.get(`/api/titles/${heat}/episodes`)).status).toBe(400);
    expect((await admin.get('/api/titles/999999/episodes')).status).toBe(404);
    expect((await new Client(app).get(`/api/titles/${sev}/episodes`)).status).toBe(401);
  });

  it('sorts a list automatically by release date or title, saved as the personal order', async () => {
    const names = async () => (await admin.get(`/api/lists/${imdbListId}/timeline`)).data.entries.map((e: any) => [e.title?.title, e.kind]);
    const r = await admin.post(`/api/lists/${imdbListId}/order/auto`, { by: 'release' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ ordered: 4, withoutDate: 0, list: { customOrder: true } });
    expect(await names()).toEqual([
      ['Thief', 'movie'],
      ['Heat', 'movie'],
      ['Severance', 'show'],
      ['Severance', 'episode'],
    ]);
    await admin.post(`/api/lists/${imdbListId}/order/auto`, { by: 'release_desc' });
    expect((await names()).map((x: any) => x[0])).toEqual(['Severance', 'Severance', 'Heat', 'Thief']);
    await admin.post(`/api/lists/${imdbListId}/order/auto`, { by: 'title' });
    expect((await names()).map((x: any) => x[0])).toEqual(['Heat', 'Severance', 'Severance', 'Thief']);
    expect((await admin.post(`/api/lists/${imdbListId}/order/auto`, { by: 'random' })).status).toBe(400);
    await admin.del(`/api/lists/${imdbListId}/order`);
    expect((await names()).map((x: any) => x[0])).toEqual(['Heat', 'Severance', 'Thief', 'Severance']);
  });

  it('adds public Letterboxd, MDBList, AniList and MyAnimeList lists by link', async () => {
    // Letterboxd: every page in order, duplicates dropped; the list syncs from then on.
    const lb = await admin.post('/api/lists/link', { url: 'https://letterboxd.com/Mann/list/michael-mann-ranked/detail/' });
    expect(lb.status).toBe(200);
    expect(lb.data.list).toMatchObject({ provider: 'letterboxd', kind: 'public', name: 'Michael Mann, Ranked', canSync: true, autoSync: true, itemCount: 3, ownerName: 'mann' });
    expect(mocks.state.letterboxdCalls).toEqual(['/mann/list/michael-mann-ranked/', '/mann/list/michael-mann-ranked/page/2/']);
    const lbItems = ctx.db.prepare('SELECT source_title, source_year, position FROM list_items WHERE list_id = ? ORDER BY position').all(lb.data.list.id);
    expect(lbItems).toEqual([
      { source_title: 'Heat', source_year: 1995, position: 1 },
      { source_title: 'Thief', source_year: 1981, position: 2 },
      { source_title: 'Collateral', source_year: 2004, position: 3 },
    ]);
    expect((await admin.post(`/api/lists/${lb.data.list.id}/sync`)).data.result).toMatchObject({ added: 0, removed: 0, total: 3 });
    expect((await admin.post('/api/lists/link', { url: 'https://letterboxd.com/mann/list/missing/' })).status).toBe(404);

    // MDBList: ids are exact; people are skipped; the name comes from the list page.
    const mdb = await admin.post('/api/lists/link', { url: 'https://mdblist.com/lists/someone/mann-and-more' });
    expect(mdb.status).toBe(200);
    expect(mdb.data.list).toMatchObject({ provider: 'mdblist', name: 'Mann & More', ownerName: 'Some One', itemCount: 2 });

    // AniList: the Planning list; anime mapped to TMDb become a season of the show or a movie.
    const ani = await admin.post('/api/lists/link', { url: 'https://anilist.co/user/kana/animelist' });
    expect(ani.status).toBe(200);
    expect(ani.data.list).toMatchObject({ provider: 'anilist', kind: 'watchlist', name: 'Kana’s Planning', itemCount: 3 });
    const aniItems = ctx.db.prepare('SELECT source_title, tmdb_id, media_type, season_number, episode_title, source_episodes FROM list_items WHERE list_id = ? ORDER BY position').all(ani.data.list.id);
    expect(aniItems).toEqual([
      { source_title: 'Severance Season 2', tmdb_id: 95396, media_type: 'tv', season_number: 2, episode_title: 'Severance Season 2', source_episodes: 10 },
      { source_title: 'Past Lives', tmdb_id: 666277, media_type: 'movie', season_number: null, episode_title: null, source_episodes: null },
      { source_title: 'Shiranai Anime', tmdb_id: null, media_type: 'tv', season_number: null, episode_title: null, source_episodes: 12 },
    ]);
    expect((await admin.post('/api/lists/link', { url: 'https://anilist.co/user/hidden/animelist' })).status).toBe(404);
    expect((await admin.post('/api/lists/link', { url: 'https://anilist.co/user/kana/animelist/Favourites' })).data.error.message).toMatch(/no anime list called/);

    // MyAnimeList: status from the link; split seasons of one show become season entries.
    const mal = await admin.post('/api/lists/link', { url: 'https://myanimelist.net/animelist/kana?status=6' });
    expect(mal.status).toBe(200);
    expect(mal.data.list).toMatchObject({ provider: 'myanimelist', name: 'kana’s Plan to Watch', itemCount: 2 });
    const malItems = ctx.db.prepare('SELECT source_title, source_year, tmdb_id, season_number FROM list_items WHERE list_id = ? ORDER BY position').all(mal.data.list.id);
    expect(malItems).toEqual([
      { source_title: 'Severance', source_year: 2022, tmdb_id: 95396, season_number: 1 },
      { source_title: 'Severance 2', source_year: 2025, tmdb_id: 95396, season_number: 2 },
    ]);
    expect((await admin.post('/api/lists/link', { url: 'https://myanimelist.net/animelist/nobody' })).status).toBe(404);

    while (ctx.matcher.pendingCount() > 0 || ctx.jobs.isRunning('match')) await triggerJob(ctx, 'match', 'manual');
    const tl = await admin.get(`/api/lists/${mal.data.list.id}/timeline`);
    expect(tl.data.entries.map((e: any) => [e.kind, e.title?.title, e.season, e.episodes])).toEqual([
      ['season', 'Severance', 1, 9],
      ['season', 'Severance', 2, 10],
    ]);

    // Links that cannot be read explain why.
    expect((await admin.post('/api/lists/link', { url: 'https://simkl.com/123/list/movies/plantowatch' })).data.error.message).toMatch(/Simkl/);
    expect((await admin.post('/api/lists/link', { url: 'https://www.themoviedb.org/list/1-marvel' })).data.error.code).toBe('tmdb_not_configured');
  });

  it('imports anime and Simkl exports as one list per status still to watch', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<myanimelist>
  <myinfo><user_name>kana</user_name><user_export_type>1</user_export_type></myinfo>
  <anime><series_animedb_id>101</series_animedb_id><series_title><![CDATA[Severance 2]]></series_title><series_type>TV</series_type><series_episodes>10</series_episodes><my_status>Plan to Watch</my_status><my_comments><![CDATA[]]></my_comments></anime>
  <anime><series_animedb_id>102</series_animedb_id><series_title><![CDATA[Past Lives]]></series_title><series_type>Movie</series_type><series_episodes>1</series_episodes><my_status>Watching</my_status></anime>
  <anime><series_animedb_id>100</series_animedb_id><series_title><![CDATA[Severance]]></series_title><series_type>TV</series_type><series_episodes>9</series_episodes><my_status>Completed</my_status></anime>
</myanimelist>`;
    const up = await admin.req('POST', '/api/lists/upload', undefined, { raw: multipart({ provider: 'myanimelist' }, { name: 'animelist_1700000000_-_1.xml', content: xml, type: 'text/xml' }) });
    expect(up.status).toBe(200);
    expect(up.data.lists.map((l: any) => [l.name, l.kind, l.applied.total, l.applied.skipped])).toEqual([
      ['MyAnimeList Plan to Watch', 'watchlist', 1, 1],
      ['MyAnimeList Watching', 'upload', 1, 0],
    ]);

    const simkl = {
      movies: [
        { status: 'plantowatch', movie: { title: 'Heat', year: 1995, ids: { simkl: 1, imdb: 'tt0113277', tmdb: 949 } } },
        { status: 'completed', movie: { title: 'Thief', year: 1981, ids: { simkl: 2, tmdb: 11524 } } },
      ],
      shows: [{ status: 'watching', show: { title: 'Severance', year: 2022, ids: { simkl: 3, tmdb: 95396, tvdb: 371980 } } }],
      anime: [{ status: 'plantowatch', anime_type: 'tv', show: { title: 'Severance', year: 2022, ids: { simkl: 5000, mal: 100 } } }],
    };
    const s = await admin.req('POST', '/api/lists/upload', undefined, { raw: multipart({ provider: 'simkl' }, { name: 'simkl-backup.json', content: JSON.stringify(simkl), type: 'application/json' }) });
    expect(s.status).toBe(200);
    expect(s.data.lists.map((l: any) => [l.name, l.applied.total])).toEqual([
      ['Simkl Plan to Watch', 2],
      ['Simkl Watching', 1],
    ]);
    const csv = 'Title,Type,Year,TMDB,IMDB\nHeat,movie,1995,949,tt0113277\nSeverance,tv,2022,95396,\n';
    const t = await admin.req('POST', '/api/lists/upload', undefined, { raw: multipart({ provider: 'tmdb' }, { name: 'mann.csv', content: csv, type: 'text/csv' }) });
    expect(t.status).toBe(200);
    expect(t.data.lists[0]).toMatchObject({ provider: 'tmdb', name: 'mann', canSync: false });
    expect((await admin.req('POST', '/api/lists/upload', undefined, { raw: multipart({ provider: 'simkl' }, { name: 'x.txt', content: 'nope', type: 'text/plain' }) })).status).toBe(400);
  });

  it('duplicates a list into an editable local list and adds titles found through Discover', async () => {
    const dup = await admin.post(`/api/lists/${imdbListId}/duplicate`, { name: 'My Mann Order' });
    expect(dup.status).toBe(200);
    expect(dup.data.list).toMatchObject({ provider: 'local', kind: 'local', name: 'My Mann Order', editable: true, canSync: false, itemCount: 4, matched: 4, timeline: true });
    const localId = dup.data.list.id;
    const titlesOf = async () => (await admin.get(`/api/lists/${localId}/timeline`)).data.entries.map((e: any) => [e.kind, e.title?.title, e.season]);
    expect(await titlesOf()).toEqual([
      ['movie', 'Heat', null],
      ['episode', 'Severance', 1],
      ['movie', 'Thief', null],
      ['show', 'Severance', null],
    ]);

    const disc = await admin.get(`/api/discover?listId=${localId}`);
    expect(disc.status).toBe(200);
    expect(disc.data.source).toBe('seerr');
    expect(disc.data.results.map((x: any) => [x.title, x.inList])).toEqual([
      ['Thief', true],
      ['Severance', true],
    ]);
    const search = await admin.get(`/api/discover?q=past%20lives&listId=${localId}`);
    const past = search.data.results[0];
    expect(past).toMatchObject({ tmdbId: 666277, mediaType: 'movie', inList: false, posterUrl: '/api/images/tmdb/w342/past.jpg' });

    const add = await admin.post(`/api/lists/${localId}/items`, { tmdbId: past.tmdbId, mediaType: 'movie', title: past.title, year: past.year, posterPath: past.posterPath });
    expect(add.status).toBe(200);
    expect(add.data.list.itemCount).toBe(5);
    expect((await admin.post(`/api/lists/${localId}/items`, { tmdbId: past.tmdbId, mediaType: 'movie', title: past.title })).status).toBe(409);

    const seasons = await admin.get('/api/discover/tv/95396');
    expect(seasons.data.seasons.filter((s: any) => s.season > 0).map((s: any) => s.episodes)).toEqual([9, 10]);
    const season = await admin.post(`/api/lists/${localId}/items`, { tmdbId: 95396, mediaType: 'tv', title: 'Severance', year: 2022, season: 2 });
    expect(season.status).toBe(200);
    const entries = (await admin.get(`/api/lists/${localId}/timeline`)).data.entries;
    expect(entries.slice(-2).map((e: any) => [e.kind, e.title?.title, e.season, e.episodes])).toEqual([
      ['movie', 'Past Lives', null, null],
      ['season', 'Severance', 2, 10],
    ]);

    const removed = await admin.del(`/api/lists/${localId}/items/${entries[0].itemId}`);
    expect(removed.data.list.itemCount).toBe(5);
    expect((await admin.post(`/api/lists/${imdbListId}/items`, { tmdbId: 666277, mediaType: 'movie', title: 'Past Lives' })).status).toBe(400);
    expect((await admin.del(`/api/lists/${imdbListId}/items/${entries[1].itemId}`)).status).toBe(400);

    // A show's specials go right after the show.
    const show = (await admin.get(`/api/lists/${localId}/timeline`)).data.entries.find((e: any) => e.kind === 'show');
    const specials = await admin.post(`/api/lists/${localId}/items`, { tmdbId: 95396, mediaType: 'tv', title: 'Severance', season: 0, afterItemId: show.itemId });
    expect(specials.status).toBe(200);
    const withSpecials = (await admin.get(`/api/lists/${localId}/timeline`)).data.entries;
    const at = withSpecials.findIndex((e: any) => e.itemId === show.itemId);
    expect(withSpecials[at]).toMatchObject({ kind: 'show' });
    expect(withSpecials[at + 1]).toMatchObject({ kind: 'season', season: 0, episodes: 1, itemId: specials.data.itemId });
    expect((await admin.post(`/api/lists/${localId}/items`, { tmdbId: 95396, mediaType: 'tv', title: 'Severance', season: 0 })).status).toBe(409);
    expect((await admin.post(`/api/lists/${imdbListId}/items`, { tmdbId: 95396, mediaType: 'tv', title: 'Severance', season: 0, afterItemId: show.itemId })).status).toBe(400);

    const empty = await admin.post('/api/lists/local', { name: 'Weekend' });
    expect(empty.data.list).toMatchObject({ provider: 'local', itemCount: 0, editable: true });
    const pastId = (ctx.db.prepare("SELECT id FROM titles WHERE tmdb_id = 666277").get() as { id: number }).id;
    const local = await admin.get(`/api/titles/${pastId}/local-lists`);
    expect(local.data.lists).toEqual([
      { id: localId, name: 'My Mann Order', contains: true },
      { id: empty.data.list.id, name: 'Weekend', contains: false },
    ]);
    const bob = new Client(app);
    await bob.login('bob', 'bob-password-1');
    expect((await bob.post(`/api/lists/${localId}/duplicate`, {})).status).toBe(404);
    expect((await bob.post(`/api/lists/${localId}/items`, { tmdbId: 1, mediaType: 'movie', title: 'x' })).status).toBe(404);
  });
});

describe('guided setup with a Jellyfin administrator, and Quick Connect sign-in', () => {
  const mocks = createMocks();
  let app: FastifyInstance;
  let ctx: AppContext;
  let dataDir: string;

  beforeAll(async () => {
    vi.stubGlobal('fetch', mocks.fetch);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jw-e2e-jf-'));
    const config = loadConfig({ JW_DATA_DIR: dataDir, JW_LOG_FILE: '0', JW_DISABLE_SCHEDULER: '1' } as NodeJS.ProcessEnv);
    const db = openDatabase(':memory:');
    await migrate(db);
    ctx = new AppContext(config, db, SecretBox.fromMaterial('c'.repeat(64)), pino({ level: process.env.JW_TEST_LOG ?? 'silent' }));
    const users = () => (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    app = await buildApp(ctx, { setupCode: () => (users() === 0 ? SETUP_CODE : null), serveWeb: false });
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllGlobals();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('checks the server, refuses non-administrators and finishes setup through Quick Connect', async () => {
    const c = new Client(app);
    expect((await c.post('/api/setup/jellyfin/check', { setupCode: 'WRONG', url: JF.url })).status).toBe(403);
    expect((await c.post('/api/setup/jellyfin/check', { setupCode: SETUP_CODE, url: 'http://nothing.test:1' })).data.error.code).toBe('jellyfin_unreachable');
    const check = await c.post('/api/setup/jellyfin/check', { setupCode: SETUP_CODE, url: `${JF.url}/` });
    expect(check.data).toMatchObject({ serverName: 'Home', quickConnect: true });

    const notAdmin = await c.post('/api/setup/jellyfin', { setupCode: SETUP_CODE, url: JF.url, username: 'bob', password: 'bobpw' });
    expect(notAdmin.status).toBe(403);
    expect(notAdmin.data.error.code).toBe('not_admin');
    expect((await c.post('/api/setup/jellyfin', { setupCode: SETUP_CODE, url: JF.url, username: 'alice', password: 'wrong' })).status).toBe(401);

    const start = await c.post('/api/setup/jellyfin/quick-connect', { setupCode: SETUP_CODE, url: JF.url });
    expect(start.data).toMatchObject({ code: '246810' });
    expect(start.body).not.toContain('qc-secret');
    expect((await c.post('/api/setup/jellyfin/quick-connect/poll', { setupCode: SETUP_CODE, id: start.data.id })).data.status).toBe('pending');
    mocks.state.quickConnectApproved = true;
    const done = await c.post('/api/setup/jellyfin/quick-connect/poll', { setupCode: SETUP_CODE, id: start.data.id, allowAll: true });
    expect(done.status).toBe(200);
    expect(done.data.status).toBe('authorized');

    const me = await c.get('/api/auth/me');
    expect(me.data.user).toMatchObject({ role: 'admin', authSource: 'jellyfin', username: 'alice', jellyfin: { userId: ALICE_JF } });
    expect(me.data).toMatchObject({ jellyfinLogin: true, jellyfin: { serverName: 'Home', quickConnect: true } });
    // The API key was created for JellyWatcher with the administrator's session, which was then ended.
    expect(mocks.state.apiKeys.map((k) => k.AppName)).toEqual(['JellyWatcher']);
    expect(ctx.integrations.isReady('jellyfin')).toBe(true);
    expect(JSON.stringify(ctx.db.prepare('SELECT * FROM integrations').all())).not.toContain(JF.key);
    expect((await c.post('/api/setup/jellyfin/quick-connect', { setupCode: SETUP_CODE, url: JF.url })).status).toBe(409);
  });

  it('signs people in with Jellyfin passwords or Quick Connect, creating member accounts', async () => {
    const bob = new Client(app);
    const r = await bob.post('/api/auth/jellyfin', { username: 'bob', password: 'bobpw' });
    expect(r.status).toBe(200);
    expect((await bob.get('/api/auth/me')).data.user).toMatchObject({ username: 'bob', role: 'user', authSource: 'jellyfin' });

    const phone = new Client(app);
    const start = await phone.post('/api/auth/quick-connect');
    expect(start.status).toBe(200);
    expect(start.data.code).toBe('246810');
    expect((await phone.post('/api/auth/quick-connect/poll', { id: 'not-a-real-request-id' })).data.status).toBe('expired');
    expect((await phone.post('/api/auth/quick-connect/poll', { id: start.data.id })).data.status).toBe('pending');
    mocks.state.quickConnectApproved = true;
    const ok = await phone.post('/api/auth/quick-connect/poll', { id: start.data.id });
    expect(ok.data.status).toBe('authorized');
    const me = await phone.get('/api/auth/me');
    expect(me.data.user).toMatchObject({ username: 'alice', role: 'admin' });
    // The request is single-use.
    expect((await phone.post('/api/auth/quick-connect/poll', { id: start.data.id })).data.status).toBe('expired');

    mocks.state.quickConnectEnabled = false;
    const off = await new Client(app).post('/api/auth/quick-connect');
    expect(off.status).toBe(400);
    expect(off.data.error.code).toBe('quick_connect_disabled');
    mocks.state.quickConnectEnabled = true;
  });

  it('imports Jellyfin users as members', async () => {
    const admin = new Client(app);
    await admin.post('/api/auth/jellyfin', { username: 'alice', password: 'alicepw' });
    await admin.get('/api/auth/me');
    const list = await admin.get('/api/admin/jellyfin-users');
    expect(list.data.users.map((u: any) => [u.name, u.linked])).toEqual([
      ['alice', true],
      ['bob', true],
    ]);
    ctx.db.prepare("DELETE FROM users WHERE username = 'bob'").run();
    const imp = await admin.post('/api/admin/users/import-jellyfin', { ids: [BOB_JF, ALICE_JF] });
    expect(imp.data.created).toBe(1);
  });
});
