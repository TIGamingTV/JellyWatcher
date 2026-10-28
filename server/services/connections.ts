import { nowIso, parseJson, type DB } from '../db/index.js';
import { ProviderError, errorMessage } from '../http/errors.js';
import { scrub } from '../logger.js';
import type { TraktClient, TraktTokens } from '../providers/trakt.js';
import type { SecretBox } from '../security/crypto.js';

export type ConnectionProvider = 'trakt' | 'letterboxd';

export interface ConnectionRecord {
  id: number;
  userId: number;
  provider: ConnectionProvider;
  accountName: string | null;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  status: 'connected' | 'needs_reauth' | 'error';
  lastError: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
}

interface Row {
  id: number;
  user_id: number;
  provider: string;
  account_name: string | null;
  config: string;
  secrets: string | null;
  status: string;
  last_error: string | null;
  last_synced_at: string | null;
  created_at: string;
}

/** Per-user connections. Secrets are encrypted at rest and never leave the server. */
export class ConnectionService {
  private refreshing = new Map<number, Promise<string>>();

  constructor(
    private readonly db: DB,
    private readonly box: SecretBox,
  ) {}

  private map(row: Row): ConnectionRecord {
    let secrets: Record<string, string> = {};
    try {
      secrets = this.box.decryptJson<Record<string, string>>(row.secrets) ?? {};
    } catch {
      secrets = {};
    }
    return {
      id: row.id,
      userId: row.user_id,
      provider: row.provider as ConnectionProvider,
      accountName: row.account_name,
      config: parseJson(row.config, {}),
      secrets,
      status: row.status as ConnectionRecord['status'],
      lastError: row.last_error,
      lastSyncedAt: row.last_synced_at,
      createdAt: row.created_at,
    };
  }

  get(userId: number, provider: ConnectionProvider): ConnectionRecord | null {
    const row = this.db.prepare('SELECT * FROM connections WHERE user_id = ? AND provider = ?').get(userId, provider) as Row | undefined;
    return row ? this.map(row) : null;
  }

  byId(id: number): ConnectionRecord | null {
    const row = this.db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as Row | undefined;
    return row ? this.map(row) : null;
  }

  save(userId: number, provider: ConnectionProvider, data: { accountName: string | null; config?: Record<string, unknown>; secrets?: Record<string, string> }): ConnectionRecord {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO connections (user_id, provider, account_name, config, secrets, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'connected', ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET account_name = excluded.account_name, config = excluded.config, secrets = excluded.secrets,
           status = 'connected', last_error = NULL, updated_at = excluded.updated_at`,
      )
      .run(userId, provider, data.accountName, JSON.stringify(data.config ?? {}), data.secrets ? this.box.encryptJson(data.secrets) : null, now, now);
    return this.get(userId, provider)!;
  }

  remove(userId: number, provider: ConnectionProvider): void {
    this.db.prepare('DELETE FROM connections WHERE user_id = ? AND provider = ?').run(userId, provider);
  }

  markError(id: number, err: unknown): void {
    const status = err instanceof ProviderError && err.kind === 'auth' ? 'needs_reauth' : 'error';
    this.db.prepare('UPDATE connections SET status = ?, last_error = ?, updated_at = ? WHERE id = ?').run(status, scrub(errorMessage(err)).slice(0, 500), nowIso(), id);
  }

  markSynced(id: number): void {
    this.db.prepare("UPDATE connections SET status = 'connected', last_error = NULL, last_synced_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), id);
  }

  private storeTraktTokens(id: number, tokens: TraktTokens): void {
    this.db.prepare('UPDATE connections SET secrets = ?, updated_at = ? WHERE id = ?').run(this.box.encryptJson({ ...tokens }), nowIso(), id);
  }

  /**
   * Returns a valid Trakt access token, refreshing it first if it expires within 10 minutes.
   * Trakt refresh tokens are single use, so refreshes are serialised per connection and persisted
   * before the new token is used.
   */
  async traktAccessToken(conn: ConnectionRecord, client: TraktClient): Promise<string> {
    const { accessToken, refreshToken, expiresAt } = conn.secrets;
    if (!accessToken || !refreshToken) throw new ProviderError('trakt', 'auth', 'Connect your Trakt account again.');
    if (expiresAt && Date.parse(expiresAt) - Date.now() > 10 * 60_000) return accessToken;

    const inflight = this.refreshing.get(conn.id);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        // Re-read in case another request refreshed in the meantime.
        const fresh = this.byId(conn.id);
        if (fresh?.secrets.expiresAt && Date.parse(fresh.secrets.expiresAt) - Date.now() > 10 * 60_000) return fresh.secrets.accessToken!;
        const tokens = await client.refresh(fresh?.secrets.refreshToken ?? refreshToken);
        this.storeTraktTokens(conn.id, tokens);
        return tokens.accessToken;
      } catch (err) {
        this.markError(conn.id, err);
        throw err;
      } finally {
        this.refreshing.delete(conn.id);
      }
    })();
    this.refreshing.set(conn.id, p);
    return p;
  }

  view(conn: ConnectionRecord | null) {
    if (!conn) return null;
    return {
      id: conn.id,
      provider: conn.provider,
      accountName: conn.accountName,
      status: conn.status,
      lastError: conn.lastError,
      lastSyncedAt: conn.lastSyncedAt,
      createdAt: conn.createdAt,
      config: conn.config,
      tokenExpiresAt: conn.provider === 'trakt' ? (conn.secrets.expiresAt ?? null) : undefined,
    };
  }
}
