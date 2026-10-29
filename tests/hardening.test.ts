import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../server/app';
import { loadConfig, trustProxySetting } from '../server/config';
import { AppContext } from '../server/context';
import { migrate, nowIso, openDatabase } from '../server/db/index';
import { HttpClient } from '../server/http/client';
import { parseMalExport } from '../server/providers/myanimelist';
import { parseSimklExport } from '../server/providers/simkl';
import { SecretBox } from '../server/security/crypto';
import { Matcher } from '../server/services/matcher';
import { TitleService } from '../server/services/titles';

const PROXY = '10.0.0.2';
const DIRECT = '100.64.0.7'; // e.g. a Tailscale peer

describe('JW_TRUST_PROXY', () => {
  it('accepts booleans and lists of proxy addresses, and rejects anything else', () => {
    expect(trustProxySetting(undefined)).toBe(false);
    expect(trustProxySetting('false')).toBe(false);
    expect(trustProxySetting('true')).toBe(true);
    expect(trustProxySetting('1')).toBe(true);
    expect(trustProxySetting('172.16.0.0/12, 10.0.0.2 ,loopback,::1')).toEqual(['172.16.0.0/12', '10.0.0.2', 'loopback', '::1']);
    expect(() => trustProxySetting('nginx')).toThrow(/JW_TRUST_PROXY/);
    expect(() => trustProxySetting('10.0.0.0/33')).toThrow(/JW_TRUST_PROXY/);
  });
});

describe('access over plain HTTP (Tailscale) and through an HTTPS reverse proxy at once', () => {
  let app: FastifyInstance;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jw-hard-'));
    const config = loadConfig({ JW_DATA_DIR: dataDir, JW_LOG_FILE: '0', JW_DISABLE_SCHEDULER: '1', JW_TRUST_PROXY: PROXY } as NodeJS.ProcessEnv);
    const db = openDatabase(':memory:');
    await migrate(db);
    const ctx = new AppContext(config, db, SecretBox.fromMaterial('c'.repeat(64)), pino({ level: 'silent' }));
    const users = () => (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    app = await buildApp(ctx, { setupCode: () => (users() === 0 ? 'CODE1-23456' : null), serveWeb: false });
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const direct = (headers: Record<string, string> = {}) => ({ remoteAddress: DIRECT, headers: { host: `${DIRECT}:8484`, ...headers } });
  const proxied = (headers: Record<string, string> = {}) => ({
    remoteAddress: PROXY,
    headers: { host: 'jellywatcher:8484', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'watch.example.com', 'x-forwarded-for': '203.0.113.9', ...headers },
  });

  it('sends no headers that would break plain HTTP, and never lets API answers be cached', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', ...direct() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(String(res.headers['content-security-policy'])).not.toContain('upgrade-insecure-requests');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('accepts same-origin writes on both addresses and blocks other origins', async () => {
    const body = { setupCode: 'WRONG', username: 'admin', password: 'a-long-password' };
    const post = (opts: { remoteAddress: string; headers: Record<string, string> }) =>
      app.inject({ method: 'POST', url: '/api/setup', payload: body, ...opts, headers: { ...opts.headers, 'content-type': 'application/json' } });
    // Wrong setup code (403 bad_setup_code) means the origin check passed.
    expect((await post(direct({ origin: `http://${DIRECT}:8484` }))).json().error.code).toBe('bad_setup_code');
    expect((await post(proxied({ origin: 'https://watch.example.com' }))).json().error.code).toBe('bad_setup_code');
    expect((await post(direct({ origin: 'https://evil.example' }))).json().error.code).toBe('bad_origin');
    // A direct client cannot vouch for another host with X-Forwarded-Host: it is not the proxy.
    expect((await post(direct({ origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' }))).json().error.code).toBe('bad_origin');
  });

  it('marks the session cookie Secure only for HTTPS through the trusted proxy', async () => {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { setupCode: 'CODE1-23456', username: 'admin', password: 'a-long-password' },
      ...proxied({ origin: 'https://watch.example.com', 'content-type': 'application/json' }),
    });
    expect(setup.statusCode).toBe(200);
    expect(String(setup.headers['set-cookie'])).toMatch(/; Secure/);
    expect(String(setup.headers['set-cookie'])).toMatch(/HttpOnly/);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'a-long-password' }, ...direct({ 'content-type': 'application/json' }) });
    expect(login.statusCode).toBe(200);
    expect(String(login.headers['set-cookie'])).not.toMatch(/Secure/);

    // A direct client claiming HTTPS is not believed either.
    const spoofed = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'a-long-password' }, ...direct({ 'content-type': 'application/json', 'x-forwarded-proto': 'https' }) });
    expect(String(spoofed.headers['set-cookie'])).not.toMatch(/Secure/);
  });

  it('keeps the sign-in limit per address even when a direct client fakes X-Forwarded-For', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'nobody', password: 'wrong' },
        remoteAddress: '100.64.0.99',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${i}` },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('HttpClient redirects', () => {
  const fetchFrom = (routes: Record<string, () => Response>, seen: { url: string; headers: Record<string, string> }[]) => async (input: string, init?: RequestInit) => {
    seen.push({ url: input, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = routes[input];
    if (!r) throw new TypeError(`unexpected ${input}`);
    return r();
  };
  const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });
  const ok = () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });

  it('never sends credential headers to another host', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const http = new HttpClient({ provider: 'seerr', baseUrl: 'http://seerr:5055', headers: () => ({ 'X-Api-Key': 'secret' }), retries: 0, fetchImpl: fetchFrom({ 'http://seerr:5055/x': redirect('https://attacker.example/x') }, seen) });
    await expect(http.get('/x')).rejects.toMatchObject({ kind: 'invalid_response' });
    expect(seen.map((s) => s.url)).toEqual(['http://seerr:5055/x']);
  });

  it('follows redirects on the same server, including http → https', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const http = new HttpClient({
      provider: 'seerr',
      baseUrl: 'http://seerr.example',
      headers: () => ({ 'X-Api-Key': 'secret' }),
      retries: 0,
      fetchImpl: fetchFrom({ 'http://seerr.example/x': redirect('https://seerr.example/x'), 'https://seerr.example/x': redirect('/y'), 'https://seerr.example/y': ok }, seen),
    });
    expect((await http.get('/x')).data).toEqual({ ok: true });
    expect(seen.every((s) => s.headers['X-Api-Key'] === 'secret')).toBe(true);
  });

  it('lets clients without credentials follow redirects normally', async () => {
    let mode: RequestRedirect | undefined;
    const http = new HttpClient({ provider: 'letterboxd', baseUrl: 'https://boxd.it', retries: 0, fetchImpl: async (_u, init) => ((mode = init?.redirect), ok()) });
    await http.get('/abc');
    expect(mode).toBe('follow');
  });
});

describe('upload size limits', () => {
  it('refuses a gzip that unpacks beyond the limit', () => {
    const bomb = gzipSync(Buffer.alloc(81 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(200_000);
    expect(() => parseMalExport(bomb, 'myanimelist', null)).toThrow(/too large/);
  });

  it('refuses a Simkl ZIP with too many files', () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 2001; i++) files[`f${i}.csv`] = new Uint8Array([0x61]);
    expect(() => parseSimklExport('export.zip', zipSync(files), null)).toThrow(/too large/);
  });
});

describe('match decisions', () => {
  it('apply to the person who made them, and administrators’ decisions to everyone', async () => {
    const db = openDatabase(':memory:');
    await migrate(db);
    const now = nowIso();
    const user = db.prepare('INSERT INTO users (id, username, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    user.run(1, 'admin', 'Admin', 'admin', now, now);
    user.run(2, 'alice', 'Alice', 'user', now, now);
    user.run(3, 'mallory', 'Mallory', 'user', now, now);
    const item = (userId: number) => {
      const list = db
        .prepare("INSERT INTO lists (user_id, provider, kind, external_id, name, created_at, updated_at) VALUES (?, 'letterboxd', 'upload', ?, 'L', ?, ?)")
        .run(userId, `u${userId}`, now, now).lastInsertRowid;
      return Number(
        db
          .prepare("INSERT INTO list_items (list_id, source_key, source_title, source_url, first_seen_at, last_seen_at) VALUES (?, 'k', 'Heat', 'https://letterboxd.com/film/heat/', ?, ?)")
          .run(list, now, now).lastInsertRowid,
      );
    };
    const [a, m] = [item(2), item(3)];
    const titles = new TitleService(db);
    const matcher = new Matcher(db, titles, pino({ level: 'silent' }));
    const status = (id: number) => (db.prepare('SELECT match_status AS s, title_id AS t FROM list_items WHERE id = ?').get(id) as { s: string; t: number | null });

    // Mallory hides the entry for herself; Alice's stays pending (nothing else can match it here).
    expect(matcher.resolveManually(m, 3, 'ignore')).toBe(1);
    db.prepare("UPDATE list_items SET match_status = 'pending' WHERE id = ?").run(a);
    await matcher.run(null);
    expect(status(a).s).toBe('pending');
    expect(status(m).s).toBe('ignored');

    // An administrator's decision applies to everyone without their own.
    const adminItem = item(1);
    matcher.resolveManually(adminItem, 1, { tmdbId: 949, mediaType: 'movie', title: 'Heat', year: 1995 });
    await matcher.run(null);
    expect(status(a)).toMatchObject({ s: 'matched' });
    expect(status(m).s).toBe('ignored');
  });
});
