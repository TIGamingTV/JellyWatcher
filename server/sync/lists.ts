import type { AppContext } from '../context.js';
import { ProviderError } from '../http/errors.js';
import { ImdbClient } from '../providers/imdb.js';
import { AnilistClient } from '../providers/anilist.js';
import { LetterboxdRssClient, LetterboxdWebClient } from '../providers/letterboxd.js';
import { MdblistClient } from '../providers/mdblist.js';
import { MalClient } from '../providers/myanimelist.js';
import { listInfoFromJson, type TraktClient } from '../providers/trakt.js';
import type { ListFetchResult } from '../providers/types.js';
import type { ApplyResult, ListRow } from '../services/lists.js';

export type TraktListRef = {
  traktId?: number;
  ownerSlug?: string;
  user?: string;
  mode?: 'watchlist' | 'owned' | 'liked' | 'public' | 'public_watchlist';
};

async function traktToken(ctx: AppContext, client: TraktClient, userId: number, required: boolean): Promise<string | undefined> {
  const conn = ctx.connections.get(userId, 'trakt');
  if (!conn) {
    if (required) throw new ProviderError('trakt', 'auth', 'Connect your Trakt account to sync this list.');
    return undefined;
  }
  try {
    return await ctx.connections.traktAccessToken(conn, client);
  } catch (err) {
    if (required) throw err;
    return undefined; // Public lists still work without a user token.
  }
}

/** Fetches a list's current contents from its source. Throws for lists that cannot be refreshed. */
export async function fetchList(ctx: AppContext, list: ListRow): Promise<ListFetchResult> {
  if (list.provider === 'trakt') {
    const client = ctx.integrations.trakt();
    if (!client) throw new ProviderError('trakt', 'config', 'Trakt is not configured. An administrator needs to add a Trakt API app.');
    const ref = ctx.lists.ref<TraktListRef>(list);
    switch (ref.mode) {
      case 'watchlist': {
        const token = (await traktToken(ctx, client, list.user_id, true))!;
        return client.watchlist(token);
      }
      case 'public_watchlist': {
        const token = await traktToken(ctx, client, list.user_id, false);
        return client.publicUserWatchlist(ref.user!, token);
      }
      case 'owned': {
        const token = (await traktToken(ctx, client, list.user_id, true))!;
        const info = await client.listInfo({ kind: 'user_list', user: ref.ownerSlug!, list: String(ref.traktId) }, token);
        const items = await client.listItems(ref.traktId!, token, ref.ownerSlug);
        return { info: listInfoFromJson(info, 'owned'), ...items };
      }
      default: {
        const token = await traktToken(ctx, client, list.user_id, false);
        const info = await client.listInfo({ kind: 'list_id', id: String(ref.traktId) }, token);
        const items = await client.listItems(ref.traktId!, token);
        return { info: listInfoFromJson(info, list.kind as 'liked' | 'public'), ...items };
      }
    }
  }
  if (list.provider === 'imdb') {
    const ref = ctx.lists.ref<{ mode?: string; listId?: string }>(list);
    if (ref.mode === 'graphql' && ref.listId) return new ImdbClient().list(ref.listId);
  }
  const ref = ctx.lists.ref<{ mode?: string; user?: string; slug?: string | null; listId?: number; status?: number; list?: string | null }>(list);
  if (list.provider === 'letterboxd' && ref.mode === 'web' && ref.user) {
    const own = ctx.connections.get(list.user_id, 'letterboxd')?.accountName;
    return new LetterboxdWebClient().list({ user: ref.user, slug: ref.slug ?? null }, own);
  }
  if (list.provider === 'tmdb' && ref.mode === 'api' && ref.listId) {
    const tmdb = ctx.integrations.tmdb();
    if (!tmdb) throw new ProviderError('tmdb', 'config', 'TMDb lists need the TMDb API token. An administrator can add it in Integrations › TMDb.');
    return tmdb.list(ref.listId);
  }
  if (list.provider === 'myanimelist' && ref.mode === 'web' && ref.user) {
    await ctx.animeIds.load();
    return new MalClient().list(ref.user, ref.status ?? 6, ctx.animeIds);
  }
  if (list.provider === 'anilist' && ref.mode === 'api' && ref.user) {
    await ctx.animeIds.load();
    return new AnilistClient().list(ref.user, ref.list ?? null, ctx.animeIds);
  }
  if (list.provider === 'mdblist' && ref.mode === 'json' && ref.user && ref.slug) return new MdblistClient().list(ref.user, ref.slug);
  if (list.provider === 'letterboxd' && list.kind === 'diary') {
    const conn = ctx.connections.get(list.user_id, 'letterboxd');
    const username = conn?.accountName ?? list.owner_name;
    if (!username) throw new ProviderError('letterboxd', 'config', 'Add your Letterboxd username to sync the diary.');
    return new LetterboxdRssClient().diary(username);
  }
  throw new ProviderError(list.provider, 'bad_request', 'This list was imported from a file. Upload a new export to update it.');
}

/** Refreshes one list end to end; safe to retry. Match resolution runs afterwards in the match job. */
export async function syncList(ctx: AppContext, list: ListRow): Promise<ApplyResult> {
  ctx.lists.markAttempt(list.id);
  try {
    const result = await fetchList(ctx, list);
    const applied = ctx.lists.applyItems(list.id, result);
    // Keep the name/description in step with the source.
    ctx.lists.upsert(list.user_id, list.provider, { ...result.info, externalId: list.external_id, kind: list.kind as never });
    if (list.connection_id) ctx.connections.markSynced(list.connection_id);
    return applied;
  } catch (err) {
    ctx.lists.markError(list.id, err);
    if (list.connection_id && err instanceof ProviderError && err.kind === 'auth') ctx.connections.markError(list.connection_id, err);
    throw err;
  }
}

export async function syncDueLists(ctx: AppContext): Promise<{ status: 'ok' | 'partial'; stats: Record<string, unknown> }> {
  const due = ctx.lists.due(ctx.settings.get('sync.listsIntervalMinutes'));
  let ok = 0;
  let failed = 0;
  let added = 0;
  let removed = 0;
  for (const list of due) {
    try {
      const r = await syncList(ctx, list);
      ok++;
      added += r.added;
      removed += r.removed;
    } catch (err) {
      failed++;
      if (err instanceof ProviderError && err.kind === 'rate_limited') break;
    }
  }
  return { status: failed > 0 ? 'partial' : 'ok', stats: { lists: due.length, ok, failed, added, removed } };
}
