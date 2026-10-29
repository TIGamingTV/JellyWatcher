import crypto from 'node:crypto';
import { z } from 'zod';
import { nowIso, parseJson, type DB } from '../db/index.js';

export const SettingsSchema = z.object({
  'sync.listsIntervalMinutes': z.number().int().min(15).max(10080),
  'sync.jellyfinIntervalMinutes': z.number().int().min(5).max(1440),
  'sync.seerrIntervalMinutes': z.number().int().min(2).max(1440),
  'sync.metadataIntervalMinutes': z.number().int().min(60).max(10080),
  'auth.jellyfinLogin': z.boolean(),
  'auth.jellyfinAutoCreate': z.boolean(),
  'requests.defaultIs4k': z.boolean(),
});
export type AppSettings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: AppSettings = {
  'sync.listsIntervalMinutes': 360,
  'sync.jellyfinIntervalMinutes': 30,
  'sync.seerrIntervalMinutes': 10,
  'sync.metadataIntervalMinutes': 720,
  'auth.jellyfinLogin': true,
  'auth.jellyfinAutoCreate': false,
  'requests.defaultIs4k': false,
};

export class SettingsStore {
  constructor(private readonly db: DB) {}

  all(): AppSettings {
    const rows = this.db.prepare("SELECT key, value FROM app_settings WHERE key NOT LIKE 'internal.%'").all() as { key: string; value: string }[];
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of rows) if (r.key in DEFAULT_SETTINGS) out[r.key] = parseJson(r.value, out[r.key]);
    const parsed = SettingsSchema.safeParse(out);
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  }

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.all()[key];
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const merged = SettingsSchema.parse({ ...this.all(), ...patch });
    const stmt = this.db.prepare(
      'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    );
    this.db.transaction(() => {
      for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS) stmt.run(k, JSON.stringify((merged as Record<string, unknown>)[k]), nowIso());
    })();
    return merged;
  }

  /** Stable per-installation id (used as the Jellyfin DeviceId). */
  instanceId(): string {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = 'internal.instanceId'").get() as { value: string } | undefined;
    if (row) return JSON.parse(row.value) as string;
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run('internal.instanceId', JSON.stringify(id), nowIso());
    return id;
  }
}
