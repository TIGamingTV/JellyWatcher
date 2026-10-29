import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';
import type { AppConfig } from './config.js';

/** Paths that must never reach a log sink. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-csrf-token"]',
  'req.headers["x-jw-plugin-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.apiKey',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.clientSecret',
  '*.secret',
];

/** Each pattern captures the prefix to keep; the secret that follows is replaced. */
const SECRET_PATTERNS: RegExp[] = [
  /(Token=")[^"]*(?=")/gi,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /(X-Api-Key:\s*)\S+/gi,
  /(X-JW-Plugin-Key:\s*)\S+/gi,
  /(\b)jwp_[A-Za-z0-9_-]{8,}/g,
  /([?&](?:api_?key|apikey|token|access_token|refresh_token|code|secret|client_secret)=)[^&\s]+/gi,
];

/** Removes credential-looking substrings from free-form text (error messages, URLs). */
export function scrub(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (_m, prefix: string) => `${prefix}[redacted]`);
  return out;
}

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const KEEP_LOGS = 3;

/** Size-based rotation performed at startup: jellywatcher.log -> .1 -> .2 -> .3 */
function rotate(file: string): void {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < MAX_LOG_BYTES) return;
    for (let i = KEEP_LOGS - 1; i >= 1; i--) {
      if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    // Rotation is best effort; logging to stdout continues regardless.
  }
}

export function createLogger(config: AppConfig): Logger {
  const streams: pino.StreamEntry[] = [];
  if (config.logPretty) {
    streams.push({
      level: config.logLevel as pino.Level,
      stream: pino.transport({ target: 'pino-pretty', options: { colorize: true } }),
    });
  } else {
    streams.push({ level: config.logLevel as pino.Level, stream: process.stdout });
  }
  if (config.logFile) {
    const dir = path.join(config.dataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'jellywatcher.log');
    rotate(file);
    streams.push({
      level: config.logLevel as pino.Level,
      stream: pino.destination({ dest: file, mkdir: true, sync: false }),
    });
  }
  return pino(
    { level: config.logLevel, redact: { paths: REDACT_PATHS, censor: '[redacted]' }, base: undefined },
    pino.multistream(streams),
  );
}
