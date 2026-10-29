import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretBox } from '../server/security/crypto';
import { hashPassword, validatePasswordStrength, verifyPassword } from '../server/security/passwords';
import { scrub } from '../server/logger';

describe('SecretBox', () => {
  it('round-trips and uses a fresh IV per encryption', () => {
    const box = SecretBox.fromMaterial('a'.repeat(64));
    const a = box.encrypt('hello');
    const b = box.encrypt('hello');
    expect(a).not.toBe(b);
    expect(box.decrypt(a)).toBe('hello');
    expect(box.decryptJson<{ k: string }>(box.encryptJson({ k: 'v' }))).toEqual({ k: 'v' });
  });

  it('detects tampering and wrong keys', () => {
    const box = SecretBox.fromMaterial('passphrase one');
    const other = SecretBox.fromMaterial('passphrase two');
    const enc = box.encrypt('secret');
    expect(() => other.decrypt(enc)).toThrow();
    const parts = enc.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => box.decrypt(parts.join(':'))).toThrow();
  });

  it('generates a key file with 0600 permissions on first load and reuses it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jw-key-'));
    const first = SecretBox.load(dir, undefined);
    expect(first.source).toBe('generated');
    expect(fs.statSync(path.join(dir, 'secret.key')).mode & 0o777).toBe(0o600);
    const enc = first.box.encrypt('x');
    const second = SecretBox.load(dir, undefined);
    expect(second.source).toBe('file');
    expect(second.box.decrypt(enc)).toBe('x');
  });
});

describe('passwords', () => {
  it('hashes with scrypt and verifies', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', null)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
  it('enforces a minimum length', () => {
    expect(validatePasswordStrength('short')).not.toBeNull();
    expect(validatePasswordStrength('long enough pw')).toBeNull();
  });
});

describe('scrub', () => {
  it('removes credentials from free text', () => {
    expect(scrub('Authorization: MediaBrowser Token="abc123", Client="x"')).not.toContain('abc123');
    expect(scrub('plugin key jwp_AbCdEf123456_-x rejected')).not.toContain('AbCdEf123456');
    expect(scrub('Bearer eyJhbGciOiJIUzI1NiJ9.x.y failed')).toBe('Bearer [redacted] failed');
    expect(scrub('GET /x?api_key=SECRET&page=2')).toBe('GET /x?api_key=[redacted]&page=2');
  });
});

describe('plugin route allowlist', () => {
  it('allows only the Watchlists page routes', async () => {
    const { pluginRouteFor } = await import('../server/security/plugin');
    expect(pluginRouteFor('GET', '/api/lists')?.user).toBe(true);
    expect(pluginRouteFor('GET', '/api/lists/12/timeline?x=1')).not.toBeNull();
    expect(pluginRouteFor('PUT', '/api/titles/3/skipped/')).not.toBeNull();
    expect(pluginRouteFor('GET', '/api/images/tmdb/w342/abc.jpg')?.user).toBe(false);
    expect(pluginRouteFor('GET', '/api/images/tmdb/w342/..%2Fetc')).toBeNull();
    expect(pluginRouteFor('DELETE', '/api/lists/12')).toBeNull();
    expect(pluginRouteFor('PATCH', '/api/lists/12')).toBeNull();
    expect(pluginRouteFor('GET', '/api/admin/users')).toBeNull();
    expect(pluginRouteFor('GET', '/api/lists/12/../../admin/users')).toBeNull();
    expect(pluginRouteFor('POST', '/api/lists/upload')).toBeNull();
  });
});
