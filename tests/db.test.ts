import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrate, nowIso, openDatabase } from '../server/db/index';
import { ListService } from '../server/services/lists';
import { TitleService } from '../server/services/titles';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../server/db/migrations');

async function freshDb() {
  const db = openDatabase(':memory:');
  await migrate(db, { dir: MIGRATIONS });
  db.prepare("INSERT INTO users (id, username, display_name, role, created_at, updated_at) VALUES (1, 'u', 'U', 'admin', ?, ?)").run(nowIso(), nowIso());
  return db;
}

describe('migrations', () => {
  it('backs up an existing database before applying new migrations, and is idempotent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jw-mig-'));
    const migDir = path.join(dir, 'migrations');
    fs.mkdirSync(migDir);
    fs.copyFileSync(path.join(MIGRATIONS, '0001_initial.sql'), path.join(migDir, '0001_initial.sql'));
    const dbFile = path.join(dir, 'jw.db');
    const backups = path.join(dir, 'backups');

    const db = openDatabase(dbFile);
    expect(await migrate(db, { dir: migDir, backupDir: backups })).toEqual(['0001_initial.sql']);
    expect(fs.existsSync(backups)).toBe(false); // nothing to back up on a brand-new database
    expect(await migrate(db, { dir: migDir, backupDir: backups })).toEqual([]);

    fs.writeFileSync(path.join(migDir, '0002_add_note.sql'), 'ALTER TABLE lists ADD COLUMN note TEXT;');
    expect(await migrate(db, { dir: migDir, backupDir: backups })).toEqual(['0002_add_note.sql']);
    const files = fs.readdirSync(backups);
    expect(files).toHaveLength(1);
    const backup = openDatabase(path.join(backups, files[0]!));
    expect((backup.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name)).toEqual(['0001_initial.sql']);
    backup.close();
    db.close();
  });

  it('rolls back a failing migration without recording it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jw-mig-'));
    fs.copyFileSync(path.join(MIGRATIONS, '0001_initial.sql'), path.join(dir, '0001_initial.sql'));
    fs.writeFileSync(path.join(dir, '0002_broken.sql'), 'CREATE TABLE ok_table (id INTEGER); THIS IS NOT SQL;');
    const db = openDatabase(':memory:');
    await expect(migrate(db, { dir })).rejects.toThrow();
    expect((db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name)).toEqual(['0001_initial.sql']);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok_table'").get()).toBeUndefined();
  });
});

describe('ListService.applyItems', () => {
  it('is idempotent, removes vanished entries and resets matches only when identity changes', async () => {
    const db = await freshDb();
    const lists = new ListService(db);
    const titles = new TitleService(db);
    const id = lists.upsert(1, 'imdb', { externalId: 'watchlist', name: 'IMDb Watchlist', kind: 'watchlist' });
    const items = [
      { sourceKey: 'tt1', title: 'A', year: 2000, mediaType: 'movie' as const, imdbId: 'tt1' },
      { sourceKey: 'tt2', title: 'B', year: 2001, mediaType: 'movie' as const, imdbId: 'tt2' },
    ];
    expect(lists.applyItems(id, { items, skipped: 0 })).toMatchObject({ added: 2, removed: 0, total: 2 });
    const tA = titles.ensure({ mediaType: 'movie', imdbId: 'tt1', tmdbId: 10, title: 'A' });
    db.prepare("UPDATE list_items SET title_id = ?, match_status = 'matched' WHERE source_key = 'tt1'").run(tA);

    expect(lists.applyItems(id, { items, skipped: 0 })).toMatchObject({ added: 0, removed: 0, updated: 0, total: 2 });
    expect(db.prepare("SELECT match_status FROM list_items WHERE source_key = 'tt1'").get()).toEqual({ match_status: 'matched' });

    // B disappears from the source; A's year is corrected by the source → re-match.
    const r = lists.applyItems(id, { items: [{ ...items[0]!, year: 1999 }], skipped: 0 });
    expect(r).toMatchObject({ added: 0, removed: 1, updated: 1, total: 1 });
    expect(db.prepare("SELECT match_status, title_id FROM list_items WHERE source_key = 'tt1'").get()).toEqual({ match_status: 'pending', title_id: null });
    expect(lists.get(id)!.item_count).toBe(1);
  });

  it('deduplicates repeated entries within one fetch', async () => {
    const db = await freshDb();
    const lists = new ListService(db);
    const id = lists.upsert(1, 'trakt', { externalId: 'list:1', name: 'L', kind: 'public' });
    const it = { sourceKey: 'movie:1', title: 'A', year: 2000, mediaType: 'movie' as const, tmdbId: 1 };
    expect(lists.applyItems(id, { items: [it, it], skipped: 0 }).total).toBe(1);
  });
});

describe('TitleService', () => {
  it('deduplicates by TMDb id, fills missing identifiers, and merges rows when metadata reveals a duplicate', async () => {
    const db = await freshDb();
    const titles = new TitleService(db);
    const a = titles.ensure({ mediaType: 'movie', tmdbId: 949, title: 'Heat' });
    expect(titles.ensure({ mediaType: 'movie', tmdbId: 949, imdbId: 'tt0113277', title: 'Heat (1995)' })).toBe(a);
    expect(titles.get(a)!.imdb_id).toBe('tt0113277');
    expect(titles.get(a)!.title).toBe('Heat'); // existing values are not overwritten by weaker sources

    // A row known only by IMDb id (e.g. from an export) later resolves to the same TMDb title.
    const b = titles.ensure({ mediaType: 'movie', imdbId: 'tt9999999', title: 'Heat?' });
    const lists = new ListService(db);
    const l = lists.upsert(1, 'imdb', { externalId: 'x', name: 'x', kind: 'upload' });
    lists.applyItems(l, { items: [{ sourceKey: 'k', title: 'Heat?', year: null, mediaType: 'movie' }], skipped: 0 });
    db.prepare('UPDATE list_items SET title_id = ?').run(b);
    const merged = titles.applyMetadata(b, { tmdbId: 949, mediaType: 'movie', title: 'Heat', originalTitle: null, year: 1995, releaseDate: '1995-12-15', overview: 'o', posterPath: '/p.jpg', backdropPath: null, genres: ['Crime'], runtime: 170, imdbId: null, tvdbId: null }, 'tmdb');
    expect(merged).toBe(a);
    expect(titles.get(b)).toBeUndefined();
    expect(db.prepare('SELECT title_id FROM list_items').get()).toEqual({ title_id: a });
  });
});
