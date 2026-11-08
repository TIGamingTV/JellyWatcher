import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../server/context';
import { inWindow, runJanitor } from '../server/janitor/engine';
import { syncJellyfin } from '../server/sync/jellyfin';
import { syncSeerr } from '../server/sync/seerr';
import { Client, SETUP_CODE, settle, testApp } from './helpers/app';
import { BOB_JF, HA, HEAT_JF, JF, RADARR, SEERR, SONARR, createMocks, sevEpisode } from './helpers/mocks';

const DAY = 86400_000;

describe('Janitor turned off (default)', () => {
  const mocks = createMocks();
  let t: Awaited<ReturnType<typeof testApp>>;
  let admin: Client;

  beforeAll(async () => {
    vi.stubGlobal('fetch', mocks.fetch);
    t = await testApp();
    admin = new Client(t.app);
    await admin.post('/api/setup', { setupCode: SETUP_CODE, username: 'admin', password: 'a-long-password' });
    await admin.get('/api/auth/me');
  });
  afterAll(async () => {
    await t.close();
    vi.unstubAllGlobals();
  });

  it('offers no routes, services, job or integrations', async () => {
    expect((await admin.get('/api/auth/me')).data.features).toEqual({ janitor: false });
    expect((await admin.get('/api/admin/janitor/overview')).status).toBe(404);
    expect((await admin.post('/api/admin/janitor/templates/movie')).status).toBe(404);
    const ints = (await admin.get('/api/integrations')).data.integrations.map((i: { provider: string }) => i.provider);
    expect(ints).toEqual(['jellyfin', 'seerr', 'tmdb', 'trakt']);
    expect((await admin.put('/api/integrations/sonarr', { config: { url: SONARR.url }, secrets: { apiKey: SONARR.key } })).status).toBe(400);
    expect((await admin.post('/api/admin/sync/janitor')).status).toBe(404);
    expect(await runJanitor(t.ctx)).toMatchObject({ status: 'skipped' });
  });
});

describe('Janitor (JW_JANITOR=1) against mocked Seerr, Jellyfin, Sonarr, Radarr and Home Assistant', () => {
  const mocks = createMocks();
  let t: Awaited<ReturnType<typeof testApp>>;
  let ctx: AppContext;
  let admin: Client;
  const T0 = Date.now();
  const at = (days: number) => new Date(T0 + days * DAY);
  const run = async (days: number) => {
    const r = await runJanitor(ctx, { now: at(days) });
    await settle(ctx);
    return r;
  };
  const candidates = async () => (await admin.get('/api/admin/janitor/candidates')).data.candidates as any[];
  const log = async () => (await admin.get('/api/admin/janitor/log')).data.entries as any[];
  let heatId: number;
  let sevId: number;
  let adminId: number;

  beforeAll(async () => {
    vi.stubGlobal('fetch', mocks.fetch);
    t = await testApp({ JW_JANITOR: '1', JW_PUBLIC_URL: 'https://jw.example.com' });
    ctx = t.ctx;
    admin = new Client(t.app);
    await admin.post('/api/setup', { setupCode: SETUP_CODE, username: 'admin', password: 'a-long-password', displayName: 'Alice' });
    adminId = (await admin.get('/api/auth/me')).data.user.id;
    expect((await admin.put('/api/integrations/jellyfin', { config: { url: JF.url }, secrets: { apiKey: JF.key } })).data.test.ok).toBe(true);
    expect((await admin.put('/api/integrations/seerr', { config: { url: SEERR.url }, secrets: { apiKey: SEERR.key } })).data.test.ok).toBe(true);
    await admin.post('/api/connections/jellyfin', { username: 'alice', password: 'alicepw' });
    await admin.post('/api/admin/users/import-jellyfin', { ids: [BOB_JF] });
    await settle(ctx);
    mocks.state.seerrMedia.set('tv:95396', { id: 2, tmdbId: 95396, tvdbId: 371980, mediaType: 'tv', status: 4 });
    mocks.state.seerrRequests.push(
      { id: 500, status: 2, is4k: false, media: { id: 1, tmdbId: 949, mediaType: 'movie', status: 5 }, requestedBy: { id: 1, displayName: 'Admin' }, seasons: [], createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 501, status: 2, is4k: false, media: { id: 2, tmdbId: 95396, tvdbId: 371980, mediaType: 'tv', status: 4 }, requestedBy: { id: 1, displayName: 'Admin' }, seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }], createdAt: '2026-08-01T00:00:00.000Z' },
    );
    // Library first (titles get their names), then requests, then the library again (episodes of requested shows).
    await syncJellyfin(ctx);
    await syncSeerr(ctx);
    await syncJellyfin(ctx);
    heatId = (ctx.db.prepare('SELECT id FROM titles WHERE tmdb_id = 949').get() as { id: number }).id;
    sevId = (ctx.db.prepare('SELECT id FROM titles WHERE tmdb_id = 95396').get() as { id: number }).id;
  });
  afterAll(async () => {
    await settle(ctx);
    await t.close();
    vi.unstubAllGlobals();
  });

  it('shows the feature to administrators and connects Sonarr, Radarr and Home Assistant', async () => {
    expect((await admin.get('/api/auth/me')).data.features).toEqual({ janitor: true });
    const bad = await admin.put('/api/integrations/sonarr', { config: { url: SONARR.url }, secrets: { apiKey: 'nope' } });
    expect(bad.data.test).toMatchObject({ ok: false });
    expect(bad.data.test.message).toMatch(/rejected the API key/);
    expect((await admin.put('/api/integrations/sonarr', { config: { url: SONARR.url }, secrets: { apiKey: SONARR.key } })).data.test).toMatchObject({ ok: true, info: { version: '4.0.10' } });
    expect((await admin.put('/api/integrations/radarr', { config: { url: RADARR.url }, secrets: { apiKey: RADARR.key } })).data.test.ok).toBe(true);
    const wrongService = await admin.put('/api/integrations/homeassistant', { config: { url: HA.url, service: 'notify.mobile_app_other' }, secrets: { token: HA.token } });
    expect(wrongService.data.test.ok).toBe(true);
    expect(wrongService.data.test.warnings[0]).toMatch(/no notify\.mobile_app_other/);
    const ha = await admin.put('/api/integrations/homeassistant', { config: { url: HA.url, service: HA.service }, secrets: { token: HA.token } });
    expect(ha.data.test).toMatchObject({ ok: true, warnings: [] });
    const all = await admin.get('/api/integrations');
    expect(all.body).not.toContain(SONARR.key);
    expect(all.body).not.toContain(HA.token);
    expect((await admin.post('/api/admin/janitor/test-notification')).status).toBe(200);
    expect(mocks.state.haNotifications.at(-1)).toMatchObject({ title: 'JellyWatcher Janitor', data: { url: 'https://jw.example.com/janitor' } });
  });

  it('validates rules and creates templates disabled and in dry run', async () => {
    const tpl = await admin.post('/api/admin/janitor/templates/movie');
    expect(tpl.data.rule).toMatchObject({ enabled: false, mode: 'dry_run', mediaType: 'movie', unit: 'movie' });
    const noDelete = await admin.put(`/api/admin/janitor/rules/${tpl.data.rule.id}`, { ...tpl.data.rule, steps: [{ type: 'wait', days: 1, hours: 0 }] });
    expect(noDelete.status).toBe(400);
    expect(noDelete.data.error.message).toMatch(/deletion step/);
    const wrongStep = await admin.put(`/api/admin/janitor/rules/${tpl.data.rule.id}`, { ...tpl.data.rule, steps: [{ type: 'sonarr_delete_season', unmonitor: true }] });
    expect(wrongStep.status).toBe(400);
    expect((await admin.del(`/api/admin/janitor/rules/${tpl.data.rule.id}`)).status).toBe(200);
  });

  let movieRule: any;
  it('runs a movie rule in dry run without deleting anything', async () => {
    movieRule = (await admin.post('/api/admin/janitor/templates/movie')).data.rule;
    movieRule = (await admin.put(`/api/admin/janitor/rules/${movieRule.id}`, { ...movieRule, enabled: true })).data.rule;
    const preview = await admin.post('/api/admin/janitor/preview', {});
    const heat = preview.data.rows.find((r: any) => r.titleId === heatId);
    expect(heat).toMatchObject({ status: 'eligible', title: 'Heat', requesters: ['Alice'] });

    await run(0);
    let [c] = await candidates();
    expect(c).toMatchObject({ titleId: heatId, state: 'waiting', dryRun: true, nextStep: 'Wait' });
    expect(Date.parse(c.nextRunAt)).toBeGreaterThan(at(6).getTime());

    await run(8); // first wait over: notification, then the 3-day notice period
    expect(mocks.state.haNotifications.at(-1)!.title).toBe('[Dry run] JellyWatcher Janitor');
    expect(mocks.state.haNotifications.at(-1)!.message).toMatch(/^Heat will be deleted on /);
    await run(12);
    [c] = await candidates();
    expect(c).toMatchObject({ state: 'done' });
    const would = (await log()).filter((e) => e.outcome === 'would');
    expect(would.map((e) => e.step).sort()).toEqual(['radarr_delete_movie', 'seerr_delete_request']);
    expect(would.find((e) => e.step === 'radarr_delete_movie').message).toMatch(/Would delete the movie .* \(20 GB\)/);
    expect(mocks.state.radarrCalls.filter((x) => x.method === 'DELETE')).toHaveLength(0);
    expect(mocks.state.seerrCalls.filter((x) => x.method === 'DELETE')).toHaveLength(0);
  });

  it('keeps excluded titles and resumes them when the exclusion is removed', async () => {
    movieRule = (await admin.put(`/api/admin/janitor/rules/${movieRule.id}`, { ...movieRule, mode: 'auto' })).data.rule;
    await settle(ctx);
    // The dry-run plan was dropped and a real one started (saving an enabled rule runs the Janitor).
    expect((await candidates()).map((c) => [c.titleId, c.dryRun])).toEqual([[heatId, false]]);
    const ex = await admin.post('/api/admin/janitor/exclusions', { titleId: heatId, reason: 'Family favourite' });
    expect(ex.data).toMatchObject({ stopped: 1 });
    await run(0);
    expect(await candidates()).toHaveLength(0);
    const preview = await admin.post('/api/admin/janitor/preview', {});
    expect(preview.data.rows.find((r: any) => r.titleId === heatId)).toMatchObject({ status: 'excluded', reason: 'Kept: Family favourite.' });
    expect((await admin.del(`/api/admin/janitor/exclusions/${ex.data.id}`)).status).toBe(200);
    await run(0);
    const [c] = await candidates();
    expect(c).toMatchObject({ titleId: heatId, state: 'waiting', dryRun: false });
  });

  it('retries a failed deletion with backoff, then deletes in Radarr and Seerr and reports it', async () => {
    await run(8);
    mocks.state.radarrDown = true;
    await run(11);
    let [c] = await candidates();
    expect(c).toMatchObject({ state: 'waiting', attempts: 1, nextStep: 'Delete movie in Radarr' });
    expect(c.lastError).toBeTruthy();
    expect((await log())[0]).toMatchObject({ step: 'radarr_delete_movie', outcome: 'failed' });

    mocks.state.radarrDown = false;
    await run(11.02); // the backoff (15 minutes) is over
    [c] = await candidates();
    expect(c).toMatchObject({ state: 'done', acted: true, freedBytes: 20 * 1024 ** 3 });
    expect(mocks.state.radarrCalls.filter((x) => x.method === 'DELETE').map((x) => x.path)).toEqual(['/movie/7?deleteFiles=true&addImportExclusion=false']);
    expect(mocks.state.seerrCalls.filter((x) => x.method === 'DELETE').map((x) => x.path)).toEqual(['/request/500']);
    expect(mocks.state.haNotifications.at(-1)).toMatchObject({ title: 'Janitor: cleaned up', message: 'Heat was deleted (20 GB freed).' });
    const req = ctx.db.prepare('SELECT request_status, last_error FROM requests WHERE seerr_request_id = 500').get() as { request_status: number | null; last_error: string };
    expect(req.request_status).toBeNull();
    const overview = (await admin.get('/api/admin/janitor/overview')).data;
    expect(overview.freedBytes.total).toBe(20 * 1024 ** 3);
    expect(overview.candidates).toHaveLength(0);
    // Gone from the plan: nothing left to pick up.
    await run(12);
    expect((await candidates()).filter((x) => x.state !== 'done')).toHaveLength(0);
  });

  let seasonRule: any;
  it('applies the multi-person settings', async () => {
    seasonRule = (await admin.post('/api/admin/janitor/templates/tv_season')).data.rule;
    const preview = async (watchers: Record<string, unknown>) =>
      (await admin.post('/api/admin/janitor/preview', { rule: { ...seasonRule, enabled: true, watchers: { ...seasonRule.watchers, ...watchers } } })).data.rows.filter((r: any) => r.titleId === sevId);
    // Requester only: season 1 is done, season 2 not started.
    const only = await preview({});
    expect(only.map((r: any) => [r.season, r.status])).toEqual([
      [1, 'eligible'],
      [2, 'waiting'],
    ]);
    expect(only[1].reason).toBe('Waiting for Alice to finish it.');
    // Everyone linked must finish: Bob never watched it.
    const all = await preview({ others: 'all_linked', dropAfterDays: null });
    expect(all[0]).toMatchObject({ status: 'waiting', reason: 'Waiting for bob to finish it.' });
    // ...unless people inactive for 30 days stop counting.
    expect((await preview({ others: 'all_linked', dropAfterDays: 30 }))[0].status).toBe('eligible');
    // Only people who started it: Bob did not.
    expect((await preview({ others: 'active', dropAfterDays: null }))[0].status).toBe('eligible');
    // Bob has it on a watchlist.
    const bobId = (ctx.db.prepare('SELECT id FROM users WHERE jellyfin_user_id = ?').get(BOB_JF) as { id: number }).id;
    const now = new Date().toISOString();
    const list = ctx.db.prepare("INSERT INTO lists (user_id, provider, kind, external_id, name, created_at, updated_at) VALUES (?, 'local', 'local', 'bob-1', 'Bob', ?, ?)").run(bobId, now, now).lastInsertRowid;
    ctx.db.prepare("INSERT INTO list_items (list_id, source_key, source_title, title_id, match_status, position, first_seen_at, last_seen_at) VALUES (?, 'sev', 'Severance', ?, 'matched', 0, ?, ?)").run(list, sevId, now, now);
    expect((await preview({ others: 'watchlisted', dropAfterDays: null }))[0].status).toBe('waiting');
    // Any one person is enough when the requester does not count.
    expect((await preview({ requester: 'ignored', others: 'all_linked', othersMode: 'at_least', atLeast: 1, dropAfterDays: null }))[0].status).toBe('eligible');
    expect((await preview({ requester: 'ignored', others: 'all_linked', othersMode: 'at_least', atLeast: 2, dropAfterDays: null }))[0].reason).toBe('Waiting for 1 more person to finish it.');
    ctx.db.prepare('DELETE FROM lists WHERE id = ?').run(list);
  });

  it('deletes a watched season after approval, then the show once it ended and every season is gone', async () => {
    seasonRule = (await admin.put(`/api/admin/janitor/rules/${seasonRule.id}`, { ...seasonRule, enabled: true, mode: 'approval' })).data.rule;
    const sev = async () => (await candidates()).filter((c) => c.titleId === sevId);
    await run(0); // season 1 was finished long ago: the first wait is over, the notice goes out
    let [s1] = await sev();
    expect(s1).toMatchObject({ season: 1, state: 'waiting', nextStep: 'Wait', label: 'Severance · Season 1' });
    // One message: the warning asks for the approval too.
    expect(mocks.state.haNotifications.at(-1)!.message).toMatch(/^Severance · Season 1 will be deleted on .+\. Approve or keep it in JellyWatcher\.$/);
    expect(s1).toMatchObject({ needsApproval: true, approvalAsked: true });
    expect(await sev()).toHaveLength(1);
    const sent = mocks.state.haNotifications.length;

    await run(3.1);
    [s1] = await sev();
    expect(s1.state).toBe('awaiting_approval');
    expect(mocks.state.haNotifications).toHaveLength(sent); // no second "approval needed"
    expect(mocks.state.sonarrFiles.filter((f) => f.seasonNumber === 1)).toHaveLength(9);
    expect((await admin.get('/api/home')).data.attention.some((a: any) => a.kind === 'janitor')).toBe(true);

    expect((await admin.post(`/api/admin/janitor/candidates/${s1.id}/approve`)).status).toBe(200);
    await settle(ctx);
    [s1] = await sev();
    expect(mocks.state.sonarrFiles.filter((f) => f.seasonNumber === 1)).toHaveLength(0);
    expect(mocks.state.sonarrSeasonMonitored[1]).toBe(false);
    expect(mocks.state.sonarrSeasonMonitored[2]).toBe(true);
    // The show continues: parked at the gate, checked again daily; the request stays.
    expect(s1).toMatchObject({ state: 'waiting', acted: true, parked: 'Waiting until the show has ended in Sonarr; checked again every day.' });
    expect(mocks.state.seerrRequests.some((r) => r.id === 501)).toBe(true);

    // Season 2 gets watched (marked by hand) and the show ends.
    ctx.watches.mark(adminId, sevId, { season: 2 }, new Date(T0).toISOString());
    mocks.state.sonarrStatus = 'ended';
    await run(2);
    let s2 = (await sev()).find((c) => c.season === 2);
    expect(s2).toMatchObject({ state: 'waiting', nextStep: 'Wait' });
    [s1] = (await sev()).filter((c) => c.season === 1);
    expect(s1).toMatchObject({ state: 'done' }); // ended, but season 2 still has files: stop here

    // Approved right after the warning: it runs on schedule without stopping.
    await run(8);
    s2 = (await sev()).find((c) => c.season === 2);
    expect(s2).toMatchObject({ state: 'waiting', needsApproval: true, approvalAsked: true });
    expect((await admin.post(`/api/admin/janitor/candidates/${s2.id}/approve`)).status).toBe(200);
    await settle(ctx);
    s2 = (await sev()).find((c) => c.season === 2);
    expect(s2).toMatchObject({ state: 'waiting', needsApproval: false });
    expect(s2.approvedAt).toBeTruthy();
    await run(11.1);
    s2 = (await sev()).find((c) => c.season === 2);
    expect(s2).toMatchObject({ state: 'done', acted: true });
    expect(mocks.state.sonarrSeriesDeleted).toBe(true);
    expect(mocks.state.sonarrCalls.find((c) => c.method === 'DELETE' && c.path.startsWith('/series/42'))!.path).toBe('/series/42?deleteFiles=true&addImportListExclusion=false');
    expect(mocks.state.seerrCalls.filter((x) => x.method === 'DELETE').map((x) => x.path)).toEqual(['/request/500', '/request/501']);
    const steps = (await log()).filter((e) => e.titleId === sevId && e.outcome === 'ok').map((e) => `${e.season}:${e.step}`);
    expect(steps.reverse()).toEqual(['1:notify', '1:sonarr_delete_season', '2:notify', '2:sonarr_delete_season', '2:sonarr_delete_series', '2:seerr_delete_request']);
  });

  it('keeps a candidate on request, and pauses everything with the kill switch', async () => {
    // A new request for Heat (downloaded again) comes in and is watched.
    mocks.state.seerrRequests.push({ id: 502, status: 2, is4k: false, media: { id: 1, tmdbId: 949, mediaType: 'movie', status: 5 }, requestedBy: { id: 1, displayName: 'Admin' }, seasons: [], createdAt: new Date().toISOString() });
    await syncSeerr(ctx);
    await run(0);
    const c = (await candidates()).find((x) => x.titleId === heatId && x.state === 'waiting');
    expect(c).toBeTruthy();
    expect((await admin.post(`/api/admin/janitor/candidates/${c.id}/keep`, { days: 30, reason: 'Rewatch' })).status).toBe(200);
    await run(1);
    expect((await candidates()).find((x) => x.titleId === heatId && x.state !== 'done')).toBeUndefined();
    const ex = (await admin.get('/api/admin/janitor/exclusions')).data.exclusions;
    expect(ex[0]).toMatchObject({ titleId: heatId, title: 'Heat', reason: 'Rewatch', active: true });
    // The exclusion runs out after 30 days.
    await admin.put('/api/admin/settings', { 'janitor.paused': true });
    const paused = await run(31);
    expect(paused.stats).toMatchObject({ blocked: 'paused' });
    const again = (await candidates()).find((x) => x.titleId === heatId && x.state === 'waiting');
    expect(again).toBeTruthy();
    const deletes = mocks.state.radarrCalls.filter((x) => x.method === 'DELETE').length;
    await run(60);
    expect(mocks.state.radarrCalls.filter((x) => x.method === 'DELETE').length).toBe(deletes);
    await admin.put('/api/admin/settings', { 'janitor.paused': false });
  });
});

describe('Janitor next season: a request for season 1 follows the requester to season 2', () => {
  const mocks = createMocks();
  let t: Awaited<ReturnType<typeof testApp>>;
  let ctx: AppContext;
  let admin: Client;
  const T0 = Date.now();
  const at = (days: number) => new Date(T0 + days * DAY);
  const run = async (days: number) => {
    const r = await runJanitor(ctx, { now: at(days) });
    await settle(ctx);
    return r;
  };
  const nextLog = async () => ((await admin.get('/api/admin/janitor/log')).data.entries as any[]).filter((e) => e.step === 'next_season');
  const sonarrPuts = () => mocks.state.sonarrCalls.filter((c) => c.method === 'PUT').length;
  let sevId: number;
  let adminId: number;
  let rule: any;

  beforeAll(async () => {
    vi.stubGlobal('fetch', mocks.fetch);
    t = await testApp({ JW_JANITOR: '1' });
    ctx = t.ctx;
    admin = new Client(t.app);
    await admin.post('/api/setup', { setupCode: SETUP_CODE, username: 'admin', password: 'a-long-password', displayName: 'Alice' });
    adminId = (await admin.get('/api/auth/me')).data.user.id;
    await admin.put('/api/integrations/jellyfin', { config: { url: JF.url }, secrets: { apiKey: JF.key } });
    await admin.put('/api/integrations/seerr', { config: { url: SEERR.url }, secrets: { apiKey: SEERR.key } });
    await admin.put('/api/integrations/sonarr', { config: { url: SONARR.url }, secrets: { apiKey: SONARR.key } });
    await admin.post('/api/connections/jellyfin', { username: 'alice', password: 'alicepw' });
    await settle(ctx);
    // Only season 1 was requested, so only season 1 is monitored and downloaded.
    mocks.state.sonarrSeasonMonitored = { 0: false, 1: true, 2: false };
    mocks.state.sonarrFiles = mocks.state.sonarrFiles.filter((f) => f.seasonNumber === 1);
    mocks.state.seerrMedia.set('tv:95396', { id: 2, tmdbId: 95396, tvdbId: 371980, mediaType: 'tv', status: 4 });
    mocks.state.seerrRequests.push({ id: 601, status: 2, is4k: false, media: { id: 2, tmdbId: 95396, tvdbId: 371980, mediaType: 'tv', status: 4 }, requestedBy: { id: 1, displayName: 'Admin' }, seasons: [{ seasonNumber: 1 }], createdAt: '2026-08-01T00:00:00.000Z' });
    await syncJellyfin(ctx);
    await syncSeerr(ctx);
    await syncJellyfin(ctx);
    sevId = (ctx.db.prepare('SELECT id FROM titles WHERE tmdb_id = 95396').get() as { id: number }).id;
    // Alice is at episode 5 of season 1: 4 episodes left.
    ctx.db.prepare('DELETE FROM watched_episodes WHERE user_id = ? AND title_id = ? AND season = 1 AND episode >= 6').run(adminId, sevId);
  });
  afterAll(async () => {
    await settle(ctx);
    await t.close();
    vi.unstubAllGlobals();
  });

  it('is on in the season template and only fits season rules', async () => {
    rule = (await admin.post('/api/admin/janitor/templates/tv_season')).data.rule;
    expect(rule.nextSeason).toEqual({ enabled: true, episodesLeft: 3, search: true });
    const movie = (await admin.post('/api/admin/janitor/templates/movie')).data.rule;
    expect(movie.nextSeason.enabled).toBe(false);
    const bad = await admin.put(`/api/admin/janitor/rules/${movie.id}`, { ...movie, nextSeason: { ...movie.nextSeason, enabled: true } });
    expect(bad.status).toBe(400);
    expect(bad.data.error.message).toMatch(/season by season/);
    await admin.del(`/api/admin/janitor/rules/${movie.id}`);
  });

  it('waits until a requester has at most 3 episodes left, and dry runs only log it once', async () => {
    rule = (await admin.put(`/api/admin/janitor/rules/${rule.id}`, { ...rule, enabled: true })).data.rule;
    await settle(ctx);
    await run(0);
    expect(await nextLog()).toHaveLength(0);

    ctx.watches.mark(adminId, sevId, { season: 1, episode: 6 }, new Date(T0).toISOString());
    await run(0);
    await run(0.1);
    const entries = await nextLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: 'would', season: 2, stepLabel: 'Monitor the next season' });
    expect(entries[0].message).toBe('Alice has 3 episodes of season 1 left: would monitor season 2 in Sonarr and search for it, and count it as requested by Alice.');
    expect(sonarrPuts()).toBe(0);
  });

  it('monitors and searches the next season for real, and counts it as part of the request', async () => {
    rule = (await admin.put(`/api/admin/janitor/rules/${rule.id}`, { ...rule, mode: 'approval' })).data.rule;
    await settle(ctx);
    await run(0.2);
    expect(mocks.state.sonarrSeasonMonitored[2]).toBe(true);
    expect(mocks.state.sonarrCalls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ name: 'SeasonSearch', seriesId: 42, seasonNumber: 2 }]);
    const [entry] = await nextLog();
    expect(entry).toMatchObject({ outcome: 'ok', season: 2 });
    expect(entry.message).toBe('Alice has 3 episodes of season 1 left: monitored season 2 in Sonarr and searched for it. It now counts as requested by Alice.');
    expect((await admin.get(`/api/admin/janitor/titles/${sevId}`)).data.addedSeasons).toMatchObject([{ season: 2, requesters: ['Alice'], monitored: true }]);
    // Done once: later runs leave Sonarr alone.
    const puts = sonarrPuts();
    await run(0.3);
    expect(sonarrPuts()).toBe(puts);
    // Season 2 is now handled like a requested season.
    const rows = (await admin.post('/api/admin/janitor/preview', {})).data.rows.filter((r: any) => r.titleId === sevId);
    expect(rows.map((r: any) => [r.season, r.status, r.requesters])).toEqual([
      [1, 'waiting', ['Alice']],
      [2, 'waiting', ['Alice']],
    ]);
  });

  it('keeps the show and the request until the added season is watched and cleaned up', async () => {
    rule = (await admin.put(`/api/admin/janitor/rules/${rule.id}`, { ...rule, mode: 'auto' })).data.rule;
    await settle(ctx);
    mocks.state.sonarrStatus = 'ended';
    ctx.watches.mark(adminId, sevId, { season: 1 }, new Date(T0).toISOString());
    await run(0.4);
    await run(8);
    await run(11.1);
    const sev = async () => ((await admin.get('/api/admin/janitor/candidates')).data.candidates as any[]).filter((c) => c.titleId === sevId);
    // Season 1 is gone; season 2 has no files yet but belongs to the request: the show stays.
    expect(mocks.state.sonarrFiles.filter((f) => f.seasonNumber === 1)).toHaveLength(0);
    expect(mocks.state.sonarrSeasonMonitored[1]).toBe(false);
    expect((await sev()).find((c) => c.season === 1)).toMatchObject({ state: 'done', acted: true });
    expect(mocks.state.sonarrSeriesDeleted).toBe(false);
    expect(mocks.state.seerrCalls.filter((x) => x.method === 'DELETE')).toHaveLength(0);

    // Season 2 arrives and gets watched: it is cleaned up, then the show and the request.
    mocks.state.sonarrFiles.push(...Array.from({ length: 10 }, (_, i) => ({ id: 300 + i, seasonNumber: 2, size: 1024 ** 3 })));
    ctx.watches.mark(adminId, sevId, { season: 2 }, at(12).toISOString());
    await run(12);
    expect((await sev()).find((c) => c.season === 2)).toMatchObject({ state: 'waiting' });
    await run(20);
    await run(23.1);
    expect((await sev()).find((c) => c.season === 2)).toMatchObject({ state: 'done', acted: true });
    expect(mocks.state.sonarrSeriesDeleted).toBe(true);
    expect(mocks.state.seerrCalls.filter((x) => x.method === 'DELETE').map((x) => x.path)).toEqual(['/request/601']);
  });
});

describe('Janitor next season: catching up with a requester who moved on by hand', () => {
  const mocks = createMocks();
  let t: Awaited<ReturnType<typeof testApp>>;
  let ctx: AppContext;
  let admin: Client;
  const T0 = Date.now();
  const at = (days: number) => new Date(T0 + days * DAY);
  const run = async (days: number) => {
    const r = await runJanitor(ctx, { now: at(days) });
    await settle(ctx);
    return r;
  };
  const nextLog = async () => ((await admin.get('/api/admin/janitor/log')).data.entries as any[]).filter((e) => e.step === 'next_season').reverse();
  let sevId: number;
  let adminId: number;
  let rule: any;

  beforeAll(async () => {
    vi.stubGlobal('fetch', mocks.fetch);
    t = await testApp({ JW_JANITOR: '1' });
    ctx = t.ctx;
    admin = new Client(t.app);
    await admin.post('/api/setup', { setupCode: SETUP_CODE, username: 'admin', password: 'a-long-password', displayName: 'Alice' });
    adminId = (await admin.get('/api/auth/me')).data.user.id;
    await admin.put('/api/integrations/jellyfin', { config: { url: JF.url }, secrets: { apiKey: JF.key } });
    await admin.put('/api/integrations/seerr', { config: { url: SEERR.url }, secrets: { apiKey: SEERR.key } });
    await admin.put('/api/integrations/sonarr', { config: { url: SONARR.url }, secrets: { apiKey: SONARR.key } });
    await admin.post('/api/connections/jellyfin', { username: 'alice', password: 'alicepw' });
    await settle(ctx);
    // Season 1 was requested; seasons 1 and 2 were watched, unmonitored and deleted by hand (before
    // the Janitor ran, so it never saw them played). Alice is at episode 6 of 8 of season 3.
    mocks.state.sonarrSeasonCounts = { 0: 1, 1: 9, 2: 10, 3: 8, 4: 8 };
    mocks.state.sonarrSeasonMonitored = { 0: false, 1: false, 2: false, 3: true, 4: false };
    mocks.state.sonarrFiles = Array.from({ length: 8 }, (_, i) => ({ id: 400 + i, seasonNumber: 3, size: 1024 ** 3 }));
    mocks.state.sevEpisodes = Array.from({ length: 8 }, (_, i) => sevEpisode(3, i + 1, i < 6));
    mocks.state.seerrMedia.set('tv:95396', { id: 2, tmdbId: 95396, tvdbId: 371980, mediaType: 'tv', status: 4 });
    mocks.state.seerrRequests.push({ id: 801, status: 2, is4k: false, media: { id: 2, tmdbId: 95396, tvdbId: 371980, mediaType: 'tv', status: 4 }, requestedBy: { id: 1, displayName: 'Admin' }, seasons: [{ seasonNumber: 1 }], createdAt: '2026-08-01T00:00:00.000Z' });
    await syncJellyfin(ctx);
    await syncSeerr(ctx);
    await syncJellyfin(ctx);
    sevId = (ctx.db.prepare('SELECT id FROM titles WHERE tmdb_id = 95396').get() as { id: number }).id;
    rule = (await admin.post('/api/admin/janitor/templates/tv_season')).data.rule;
  });
  afterAll(async () => {
    await settle(ctx);
    await t.close();
    vi.unstubAllGlobals();
  });

  it('adds the season they are on to the request, then monitors the one after it, never an old one', async () => {
    rule = (await admin.put(`/api/admin/janitor/rules/${rule.id}`, { ...rule, enabled: true, mode: 'auto' })).data.rule;
    await settle(ctx);
    await run(0);
    const entries = await nextLog();
    expect(entries.map((e) => [e.season, e.outcome, e.message])).toEqual([
      [3, 'ok', 'Alice requested season 1, but the show has moved on: season 3 now counts as requested by Alice.'],
      [4, 'ok', 'Alice has 2 episodes of season 3 left: monitored season 4 in Sonarr and searched for it. It now counts as requested by Alice.'],
    ]);
    // Seasons already watched and deleted stay that way.
    expect(mocks.state.sonarrSeasonMonitored).toMatchObject({ 1: false, 2: false, 3: true, 4: true });
    expect(mocks.state.sonarrCalls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ name: 'SeasonSearch', seriesId: 42, seasonNumber: 4 }]);
    // Nothing more on later runs.
    await run(0.1);
    expect(await nextLog()).toHaveLength(2);

    const rows = (await admin.post('/api/admin/janitor/preview', {})).data.rows.filter((r: any) => r.titleId === sevId);
    // Season 1 is behind them: not listed.
    expect(rows.map((r: any) => [r.season, r.status])).toEqual([
      [3, 'waiting'],
      [4, 'not_in_library'],
    ]);
    expect(rows[0]).toMatchObject({ requesters: ['Alice'], reason: 'Waiting for Alice to finish it.' });
  });

  it('cleans up the season they are on and keeps the show for the next one', async () => {
    mocks.state.sonarrStatus = 'ended';
    ctx.watches.mark(adminId, sevId, { season: 3 }, new Date(T0).toISOString());
    await run(0.2);
    await run(8);
    await run(11.1);
    const s3 = ((await admin.get('/api/admin/janitor/candidates')).data.candidates as any[]).find((c) => c.titleId === sevId && c.season === 3);
    expect(s3).toMatchObject({ state: 'done', acted: true });
    expect(mocks.state.sonarrFiles).toHaveLength(0);
    expect(mocks.state.sonarrSeasonMonitored[3]).toBe(false);
    // Season 4 is still to come: the show and the request stay.
    expect(mocks.state.sonarrSeriesDeleted).toBe(false);
    expect(mocks.state.seerrCalls.filter((x) => x.method === 'DELETE')).toHaveLength(0);
  });
});

describe('Janitor: titles deleted outside the Janitor', () => {
  const mocks = createMocks();
  let t: Awaited<ReturnType<typeof testApp>>;
  let ctx: AppContext;
  let admin: Client;
  let heatId: number;
  const heatRows = async () => ((await admin.post('/api/admin/janitor/preview', {})).data.rows as any[]).filter((r) => r.titleId === heatId);

  beforeAll(async () => {
    vi.stubGlobal('fetch', mocks.fetch);
    t = await testApp({ JW_JANITOR: '1' });
    ctx = t.ctx;
    admin = new Client(t.app);
    await admin.post('/api/setup', { setupCode: SETUP_CODE, username: 'admin', password: 'a-long-password', displayName: 'Alice' });
    await admin.put('/api/integrations/jellyfin', { config: { url: JF.url }, secrets: { apiKey: JF.key } });
    await admin.put('/api/integrations/seerr', { config: { url: SEERR.url }, secrets: { apiKey: SEERR.key } });
    await admin.put('/api/integrations/radarr', { config: { url: RADARR.url }, secrets: { apiKey: RADARR.key } });
    await admin.post('/api/connections/jellyfin', { username: 'alice', password: 'alicepw' });
    await settle(ctx);
    mocks.state.seerrRequests.push({ id: 900, status: 5, is4k: false, media: { id: 1, tmdbId: 949, mediaType: 'movie', status: 5 }, requestedBy: { id: 1, displayName: 'Admin' }, seasons: [], createdAt: '2026-08-01T00:00:00.000Z' });
    await syncJellyfin(ctx);
    await syncSeerr(ctx);
    heatId = (ctx.db.prepare('SELECT id FROM titles WHERE tmdb_id = 949').get() as { id: number }).id;
    const rule = (await admin.post('/api/admin/janitor/templates/movie')).data.rule;
    await admin.put(`/api/admin/janitor/rules/${rule.id}`, { ...rule, enabled: true });
    await settle(ctx);
  });
  afterAll(async () => {
    await settle(ctx);
    await t.close();
    vi.unstubAllGlobals();
  });

  it('does not list a movie deleted from Jellyfin and Radarr', async () => {
    expect((await heatRows()).map((r) => r.status)).toEqual(['eligible']);
    // Deleted by hand in Radarr (files too): Jellyfin loses it, the Seerr request is still there.
    mocks.state.radarrMovies = [];
    mocks.state.jellyfinRemoved.add(HEAT_JF);
    await syncJellyfin(ctx);
    expect(await heatRows()).toEqual([]);
  });

  it('drops requests deleted in Seerr, completed ones included', async () => {
    mocks.state.seerrRequests = [];
    await syncSeerr(ctx);
    expect(ctx.db.prepare('SELECT request_status, last_error FROM requests WHERE seerr_request_id = 900').get()).toEqual({ request_status: null, last_error: 'This request no longer exists in Seerr.' });
    expect((await admin.get(`/api/admin/janitor/titles/${heatId}`)).data.requested).toBe(false);
  });
});

describe('Janitor: what an administrator decides always wins', () => {
  type Setup = Awaited<ReturnType<typeof setup>>;
  const SEASON_STEPS = [
    { type: 'sonarr_delete_season', unmonitor: true },
    { type: 'gate', condition: 'series_ended', otherwise: 'recheck' },
    { type: 'sonarr_delete_series', importListExclusion: false },
  ];
  const seasonRule = (steps: unknown[], mode = 'auto') => ({ name: 'Seasons', enabled: true, mediaType: 'tv', unit: 'season', mode, steps });
  let s: Setup | null = null;

  /** Severance requested (seasons 1 and 2); Alice watched season 1. */
  async function setup(mocks = createMocks(), fetchImpl: typeof fetch = mocks.fetch, before?: () => void) {
    vi.stubGlobal('fetch', fetchImpl);
    const t = await testApp({ JW_JANITOR: '1' });
    const admin = new Client(t.app);
    await admin.post('/api/setup', { setupCode: SETUP_CODE, username: 'admin', password: 'a-long-password', displayName: 'Alice' });
    await admin.put('/api/integrations/jellyfin', { config: { url: JF.url }, secrets: { apiKey: JF.key } });
    await admin.put('/api/integrations/seerr', { config: { url: SEERR.url }, secrets: { apiKey: SEERR.key } });
    await admin.put('/api/integrations/sonarr', { config: { url: SONARR.url }, secrets: { apiKey: SONARR.key } });
    await admin.post('/api/connections/jellyfin', { username: 'alice', password: 'alicepw' });
    await settle(t.ctx);
    before?.();
    mocks.state.seerrMedia.set('tv:95396', { id: 2, tmdbId: 95396, tvdbId: 371980, mediaType: 'tv', status: 4 });
    mocks.state.seerrRequests.push({ id: 501, status: 2, is4k: false, media: { id: 2, tmdbId: 95396, tvdbId: 371980, mediaType: 'tv', status: 4 }, requestedBy: { id: 1, displayName: 'Admin' }, seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }], createdAt: '2026-08-01T00:00:00.000Z' });
    await syncJellyfin(t.ctx);
    await syncSeerr(t.ctx);
    await syncJellyfin(t.ctx);
    const sevId = (t.ctx.db.prepare('SELECT id FROM titles WHERE tmdb_id = 95396').get() as { id: number }).id;
    const run = async (days: number) => {
      const r = await runJanitor(t.ctx, { now: new Date(Date.now() + days * DAY) });
      await settle(t.ctx);
      return r;
    };
    const rule = async (body: unknown) => (await admin.post('/api/admin/janitor/rules', body)).data.rule as { id: number };
    const candidates = () => t.ctx.db.prepare('SELECT season, state, step_index, acted FROM janitor_candidates WHERE title_id = ?').all(sevId);
    s = { t, admin, mocks, sevId, run, rule, candidates } as never;
    return { t, admin, mocks, sevId, run, rule, candidates };
  }
  afterEach(async () => {
    if (!s) return;
    await settle(s.t.ctx);
    await s.t.close();
    vi.unstubAllGlobals();
    s = null;
  });

  it('keeping a season stops a cleanup that already deleted another one before it deletes the show', async () => {
    const { admin, mocks, sevId, run, rule, candidates } = await setup();
    await rule(seasonRule(SEASON_STEPS));
    await run(0);
    expect(mocks.state.sonarrFiles.filter((f) => f.seasonNumber === 1)).toHaveLength(0);
    expect(candidates()).toEqual([{ season: 1, state: 'waiting', step_index: 1, acted: 1 }]);
    await admin.post('/api/admin/janitor/exclusions', { titleId: sevId, season: 2 });
    mocks.state.sonarrStatus = 'ended';
    await run(1.1);
    expect(mocks.state.sonarrSeriesDeleted).toBe(false);
    expect(mocks.state.sonarrFiles).toHaveLength(10);
    expect(candidates()).toEqual([]);
  });

  it('keeping the whole title stops cleanups that already deleted something at once', async () => {
    const { admin, mocks, sevId, run, rule, candidates } = await setup();
    await rule(seasonRule(SEASON_STEPS));
    await run(0);
    expect((await admin.post('/api/admin/janitor/exclusions', { titleId: sevId })).data.stopped).toBe(1);
    mocks.state.sonarrStatus = 'ended';
    await run(1.1);
    expect(mocks.state.sonarrSeriesDeleted).toBe(false);
    expect(candidates()).toEqual([]);
  });

  it('switching a rule to dry run stops real deletions of cleanups already under way', async () => {
    const { admin, mocks, run, rule } = await setup();
    const r = await rule(seasonRule(SEASON_STEPS));
    await run(0);
    expect((await admin.put(`/api/admin/janitor/rules/${r.id}`, seasonRule(SEASON_STEPS, 'dry_run'))).status).toBe(200);
    mocks.state.sonarrStatus = 'ended';
    await run(1.1);
    expect(mocks.state.sonarrSeriesDeleted).toBe(false);
  });

  it('a cleanup kept while a run handles another one is not deleted by that run', async () => {
    const mocks = createMocks();
    let armed = false;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      // While the movie cleanup sends its notification, the administrator keeps the season.
      if (armed && url.startsWith(HA.url) && url.includes('/api/services/notify')) {
        armed = false;
        const c = s!.t.ctx.db.prepare('SELECT id FROM janitor_candidates WHERE title_id = ?').get(s!.sevId) as { id: number };
        expect((await s!.admin.post(`/api/admin/janitor/candidates/${c.id}/keep`, {})).status).toBe(200);
      }
      return mocks.fetch(input, init);
    }) as typeof fetch;
    const { admin, run, rule } = await setup(mocks, fetchImpl, () => {
      mocks.state.seerrRequests.push({ id: 500, status: 2, is4k: false, media: { id: 1, tmdbId: 949, mediaType: 'movie', status: 5 }, requestedBy: { id: 1, displayName: 'Admin' }, seasons: [], createdAt: '2026-08-01T00:00:00.000Z' });
    });
    await admin.put('/api/integrations/radarr', { config: { url: RADARR.url }, secrets: { apiKey: RADARR.key } });
    await admin.put('/api/integrations/homeassistant', { config: { url: HA.url, service: HA.service }, secrets: { token: HA.token } });
    await rule({ name: 'Movies', enabled: true, mediaType: 'movie', unit: 'movie', mode: 'auto', steps: [{ type: 'notify', message: '{title}' }, { type: 'radarr_delete_movie', importExclusion: false }] });
    await rule(seasonRule([{ type: 'sonarr_delete_season', unmonitor: true }]));
    armed = true;
    await run(0);
    expect(armed).toBe(false);
    expect(mocks.state.radarrMovies).toHaveLength(0);
    expect(mocks.state.sonarrFiles.filter((f) => f.seasonNumber === 1)).toHaveLength(9);
  });

  it('changed steps restart a cleanup that already deleted something instead of skipping ahead', async () => {
    const { admin, mocks, run, rule, candidates } = await setup();
    const r = await rule(seasonRule([{ type: 'notify', message: 'a' }, { type: 'notify', message: 'b' }, ...SEASON_STEPS]));
    await run(0);
    expect(candidates()).toEqual([{ season: 1, state: 'waiting', step_index: 3, acted: 1 }]);
    // Index 3 of the new steps would be "delete the show", past the new gate.
    const steps = [SEASON_STEPS[0], SEASON_STEPS[1], { type: 'gate', condition: 'no_files_left', otherwise: 'stop' }, SEASON_STEPS[2]];
    await admin.put(`/api/admin/janitor/rules/${r.id}`, seasonRule(steps));
    await settle(s!.t.ctx);
    // The save runs the Janitor: it went through the steps again and waits at the first gate.
    expect(mocks.state.sonarrSeriesDeleted).toBe(false);
    expect(candidates()).toEqual([{ season: 1, state: 'waiting', step_index: 1, acted: 1 }]);
    // Steps after its place changed only: it stays where it is.
    await admin.put(`/api/admin/janitor/rules/${r.id}`, seasonRule(steps.slice(0, 2)));
    expect(candidates()).toEqual([{ season: 1, state: 'waiting', step_index: 1, acted: 1 }]);
  });

  it('a requested season that is not downloaded yet keeps the show', async () => {
    const mocks = createMocks();
    const { run, rule } = await setup(mocks, mocks.fetch, () => {
      // Season 2: requested and monitored in Sonarr, nothing downloaded yet.
      mocks.state.sonarrFiles = mocks.state.sonarrFiles.filter((f) => f.seasonNumber === 1);
      mocks.state.sevEpisodes = mocks.state.sevEpisodes.filter((e) => e.ParentIndexNumber === 1);
      mocks.state.sonarrStatus = 'ended';
    });
    await rule(seasonRule([...SEASON_STEPS.slice(0, 2), { type: 'gate', condition: 'no_files_left', otherwise: 'stop' }, SEASON_STEPS[2], { type: 'seerr_delete_request' }]));
    await run(0);
    expect(mocks.state.sonarrFiles).toHaveLength(0);
    expect(mocks.state.sonarrSeriesDeleted).toBe(false);
    expect(mocks.state.seerrCalls.filter((c) => c.method === 'DELETE')).toEqual([]);
    // Whole-show rules wait for it too.
    const preview = (await s!.admin.post('/api/admin/janitor/preview', { rule: { name: 'Shows', enabled: true, mediaType: 'tv', unit: 'series', mode: 'auto', steps: [SEASON_STEPS[2]] } })).data.rows;
    expect(preview.map((x: any) => [x.status, x.reason])).toEqual([['incomplete', 'Season 2 is not downloaded yet.']]);
  });

  it('a request missing from Seerr’s list is only dropped once Seerr says it is gone', async () => {
    const { t, mocks } = await setup();
    mocks.state.seerrListHidden.add(501);
    await syncSeerr(t.ctx);
    expect(t.ctx.db.prepare('SELECT request_status FROM requests WHERE seerr_request_id = 501').get()).toEqual({ request_status: 2 });
    mocks.state.seerrRequests = [];
    await new Promise((r) => setTimeout(r, 5)); // a later sync
    await syncSeerr(t.ctx);
    expect(t.ctx.db.prepare('SELECT request_status FROM requests WHERE seerr_request_id = 501').get()).toEqual({ request_status: null });
  });
});

describe('Janitor helpers', () => {
  it('checks the deletion window, also across midnight', () => {
    const d = (h: number, m = 0) => new Date(2026, 0, 1, h, m);
    expect(inWindow(d(12), '', '')).toBe(true);
    expect(inWindow(d(3), '02:00', '05:00')).toBe(true);
    expect(inWindow(d(5), '02:00', '05:00')).toBe(false);
    expect(inWindow(d(23, 30), '23:00', '04:00')).toBe(true);
    expect(inWindow(d(2), '23:00', '04:00')).toBe(true);
    expect(inWindow(d(12), '23:00', '04:00')).toBe(false);
  });
});
