import { nowIso, parseJson, type DB } from '../db/index.js';
import { errorMessage } from '../http/errors.js';
import { JellyfinClient } from '../providers/jellyfin.js';
import { SeerrClient } from '../providers/seerr.js';
import { TmdbClient } from '../providers/tmdb.js';
import { TraktClient } from '../providers/trakt.js';
import type { SecretBox } from '../security/crypto.js';
import { scrub } from '../logger.js';

export type ServerIntegration = 'jellyfin' | 'seerr' | 'tmdb' | 'trakt';
export const SERVER_INTEGRATIONS: ServerIntegration[] = ['jellyfin', 'seerr', 'tmdb', 'trakt'];

export interface IntegrationRecord {
  provider: ServerIntegration;
  enabled: boolean;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  status: 'unconfigured' | 'ok' | 'error';
  lastCheckedAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  serverInfo: Record<string, unknown> | null;
}

/** Which secret fields each integration has. Values are never returned to clients. */
export const SECRET_FIELDS: Record<ServerIntegration, string[]> = {
  jellyfin: ['apiKey'],
  seerr: ['apiKey'],
  tmdb: ['token'],
  trakt: ['clientSecret'],
};

interface Row {
  provider: string;
  enabled: number;
  config: string;
  secrets: string | null;
  status: string;
  last_checked_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  server_info: string | null;
}

export class IntegrationStore {
  constructor(
    private readonly db: DB,
    private readonly box: SecretBox,
    private readonly version: string,
    private readonly instanceId: () => string,
  ) {}

  get(provider: ServerIntegration): IntegrationRecord {
    const row = this.db.prepare('SELECT * FROM integrations WHERE provider = ?').get(provider) as Row | undefined;
    if (!row) {
      return { provider, enabled: false, config: {}, secrets: {}, status: 'unconfigured', lastCheckedAt: null, lastOkAt: null, lastError: null, serverInfo: null };
    }
    let secrets: Record<string, string> = {};
    try {
      secrets = this.box.decryptJson<Record<string, string>>(row.secrets) ?? {};
    } catch {
      // Wrong JW_SECRET_KEY or a corrupted value; treat as missing so the admin re-enters it.
      secrets = {};
    }
    return {
      provider,
      enabled: row.enabled === 1,
      config: parseJson(row.config, {}),
      secrets,
      status: row.status as IntegrationRecord['status'],
      lastCheckedAt: row.last_checked_at,
      lastOkAt: row.last_ok_at,
      lastError: row.last_error,
      serverInfo: parseJson(row.server_info, null),
    };
  }

  /** Saves config; secrets with empty/undefined values keep their stored value. `null` removes a secret. */
  save(provider: ServerIntegration, config: Record<string, unknown>, secrets: Record<string, string | null | undefined>, enabled = true): IntegrationRecord {
    const current = this.get(provider);
    const merged: Record<string, string> = { ...current.secrets };
    for (const [k, v] of Object.entries(secrets)) {
      if (!SECRET_FIELDS[provider].includes(k)) continue;
      if (v === null) delete merged[k];
      else if (typeof v === 'string' && v.trim() !== '') merged[k] = v.trim();
    }
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO integrations (provider, enabled, config, secrets, status, updated_at) VALUES (@provider, @enabled, @config, @secrets, 'unconfigured', @now)
         ON CONFLICT(provider) DO UPDATE SET enabled = excluded.enabled, config = excluded.config, secrets = excluded.secrets, updated_at = excluded.updated_at`,
      )
      .run({ provider, enabled: enabled ? 1 : 0, config: JSON.stringify(config), secrets: this.box.encryptJson(merged), now });
    return this.get(provider);
  }

  remove(provider: ServerIntegration): void {
    this.db.prepare('DELETE FROM integrations WHERE provider = ?').run(provider);
  }

  markOk(provider: ServerIntegration, serverInfo?: Record<string, unknown>): void {
    const now = nowIso();
    this.db
      .prepare('UPDATE integrations SET status = ?, last_checked_at = ?, last_ok_at = ?, last_error = NULL, server_info = COALESCE(?, server_info) WHERE provider = ?')
      .run('ok', now, now, serverInfo ? JSON.stringify(serverInfo) : null, provider);
  }

  markError(provider: ServerIntegration, err: unknown): void {
    this.db
      .prepare('UPDATE integrations SET status = ?, last_checked_at = ?, last_error = ? WHERE provider = ?')
      .run('error', nowIso(), scrub(errorMessage(err)).slice(0, 500), provider);
  }

  isReady(provider: ServerIntegration): boolean {
    const r = this.get(provider);
    if (!r.enabled) return false;
    switch (provider) {
      case 'jellyfin':
      case 'seerr':
        return Boolean(r.config.url && r.secrets.apiKey);
      case 'tmdb':
        return Boolean(r.secrets.token);
      case 'trakt':
        return Boolean(r.config.clientId);
    }
  }

  jellyfin(): JellyfinClient | null {
    const r = this.get('jellyfin');
    if (!this.isReady('jellyfin')) return null;
    return new JellyfinClient(String(r.config.url), r.secrets.apiKey!, `jellywatcher-${this.instanceId()}`, this.version);
  }

  /** A client for verifying credentials against a URL without an API key (e.g. during setup). */
  jellyfinAt(url: string, apiKey: string | null): JellyfinClient {
    return new JellyfinClient(url, apiKey, `jellywatcher-${this.instanceId()}`, this.version);
  }

  jellyfinPublicUrl(): string | null {
    const r = this.get('jellyfin');
    return (r.config.publicUrl as string | undefined) || (r.config.url as string | undefined) || null;
  }

  seerr(): SeerrClient | null {
    const r = this.get('seerr');
    if (!this.isReady('seerr')) return null;
    return new SeerrClient(String(r.config.url), r.secrets.apiKey!);
  }

  seerrPublicUrl(): string | null {
    const r = this.get('seerr');
    return (r.config.publicUrl as string | undefined) || (r.config.url as string | undefined) || null;
  }

  tmdb(): TmdbClient | null {
    const r = this.get('tmdb');
    if (!this.isReady('tmdb')) return null;
    return new TmdbClient(r.secrets.token!);
  }

  trakt(): TraktClient | null {
    const r = this.get('trakt');
    if (!this.isReady('trakt')) return null;
    return new TraktClient(String(r.config.clientId), r.secrets.clientSecret);
  }

  /** Public view: never includes secret values, only whether they are set. */
  view(provider: ServerIntegration) {
    const r = this.get(provider);
    const secretsSet = Object.fromEntries(SECRET_FIELDS[provider].map((k) => [k, Boolean(r.secrets[k])]));
    return {
      provider,
      enabled: r.enabled,
      ready: this.isReady(provider),
      config: r.config,
      secretsSet,
      status: r.status,
      lastCheckedAt: r.lastCheckedAt,
      lastOkAt: r.lastOkAt,
      lastError: r.lastError,
      serverInfo: r.serverInfo,
    };
  }
}
