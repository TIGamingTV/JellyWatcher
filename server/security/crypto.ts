import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Authenticated encryption for credentials at rest (AES-256-GCM).
 * Key source, in order: JW_SECRET_KEY env var, or <dataDir>/secret.key (generated on first run, 0600).
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('SecretBox key must be 32 bytes');
    this.key = key;
  }

  static fromMaterial(material: string): SecretBox {
    const trimmed = material.trim();
    let raw: Buffer | null = null;
    if (/^[0-9a-f]{64}$/i.test(trimmed)) raw = Buffer.from(trimmed, 'hex');
    else {
      const b = Buffer.from(trimmed, 'base64');
      if (b.length === 32 && /^[A-Za-z0-9+/_-]+=*$/.test(trimmed)) raw = b;
    }
    // Any other passphrase is stretched into a key. A fixed salt is acceptable here because
    // the passphrase is a deployment secret, not a user password.
    if (!raw) raw = crypto.scryptSync(trimmed, 'jellywatcher.secretbox.v1', 32);
    return new SecretBox(raw);
  }

  static load(dataDir: string, envKey: string | undefined): { box: SecretBox; source: 'env' | 'file' | 'generated' } {
    if (envKey) return { box: SecretBox.fromMaterial(envKey), source: 'env' };
    const file = path.join(dataDir, 'secret.key');
    if (fs.existsSync(file)) return { box: SecretBox.fromMaterial(fs.readFileSync(file, 'utf8')), source: 'file' };
    fs.mkdirSync(dataDir, { recursive: true });
    const key = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, `${key}\n`, { mode: 0o600 });
    return { box: SecretBox.fromMaterial(key), source: 'generated' };
  }

  encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
  }

  decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split(':');
    if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unsupported secret format');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }

  encryptJson(value: Record<string, unknown>): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson<T extends Record<string, unknown>>(payload: string | null | undefined): T | null {
    if (!payload) return null;
    return JSON.parse(this.decrypt(payload)) as T;
  }
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
