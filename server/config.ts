import { isIP } from 'node:net';
import path from 'node:path';

declare const __APP_VERSION__: string | undefined;

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = v ? Number.parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function publicUrl(v: string | undefined): URL | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
    return u;
  } catch {
    throw new Error(`JW_PUBLIC_URL is not a valid http(s) URL: ${v}`);
  }
}

const PROXY_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * JW_TRUST_PROXY: `false` (default), `true` (trust X-Forwarded-* from every peer), or a comma-separated
 * list of proxy addresses / CIDR ranges (plus `loopback`, `linklocal`, `uniquelocal`). Use a list when
 * JellyWatcher is reachable both through the proxy and directly (e.g. over Tailscale): with `true`, a
 * direct client could fake X-Forwarded-For and dodge the per-address sign-in limits.
 */
export function trustProxySetting(v: string | undefined): boolean | string[] {
  const raw = (v ?? '').trim();
  if (raw === '' || ['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const e of entries) {
    if (PROXY_NAMES.has(e)) continue;
    const [addr, bits, extra] = e.split('/');
    const family = isIP(addr ?? '');
    const max = family === 4 ? 32 : 128;
    const bitsOk = bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= max);
    if (!family || !bitsOk || extra !== undefined) throw new Error(`JW_TRUST_PROXY: "${e}" is not an IP address or CIDR range`);
  }
  return entries;
}

export interface AppConfig {
  version: string;
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  secretKey: string | undefined;
  publicUrl: URL | null;
  trustProxy: boolean | string[];
  cookieSecure: 'auto' | boolean;
  sessionTtlDays: number;
  logLevel: string;
  logPretty: boolean;
  logFile: boolean;
  setupToken: string | undefined;
  disableScheduler: boolean;
  webDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = path.resolve(env.JW_DATA_DIR ?? '/data');
  const cookieSecureRaw = (env.JW_COOKIE_SECURE ?? 'auto').toLowerCase();
  return {
    version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : (env.npm_package_version ?? 'dev'),
    host: env.JW_HOST ?? '0.0.0.0',
    port: int(env.JW_PORT, 8484, 1, 65535),
    dataDir,
    dbPath: path.join(dataDir, 'jellywatcher.db'),
    secretKey: env.JW_SECRET_KEY || undefined,
    publicUrl: publicUrl(env.JW_PUBLIC_URL),
    trustProxy: trustProxySetting(env.JW_TRUST_PROXY),
    cookieSecure: cookieSecureRaw === 'auto' ? 'auto' : bool(cookieSecureRaw, false),
    sessionTtlDays: int(env.JW_SESSION_TTL_DAYS, 30, 1, 365),
    logLevel: env.JW_LOG_LEVEL ?? 'info',
    logPretty: bool(env.JW_LOG_PRETTY, false),
    logFile: bool(env.JW_LOG_FILE, true),
    setupToken: env.JW_SETUP_TOKEN || undefined,
    disableScheduler: bool(env.JW_DISABLE_SCHEDULER, false),
    webDir: path.resolve(env.JW_WEB_DIR ?? path.join(process.cwd(), 'dist/web')),
  };
}
