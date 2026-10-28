import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { AppContext } from './context.js';
import { migrate, openDatabase } from './db/index.js';
import { createLogger } from './logger.js';
import { SecretBox } from './security/crypto.js';
import { Scheduler } from './sync/scheduler.js';

function assertWritable(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    const uid = typeof process.getuid === 'function' ? process.getuid() : '?';
    console.error(
      `JellyWatcher cannot write to its data directory ${dir} (running as uid ${uid}).\n` +
        `Fix the ownership of the mounted folder on the host, e.g.: sudo chown -R ${uid}:${uid} ./data`,
    );
    process.exit(78);
  }
}

async function main() {
  const config = loadConfig();
  assertWritable(config.dataDir);
  const log = createLogger(config);
  log.info({ version: config.version, dataDir: config.dataDir }, 'starting JellyWatcher');

  const { box, source } = SecretBox.load(config.dataDir, config.secretKey);
  if (source === 'generated') log.warn({ file: path.join(config.dataDir, 'secret.key') }, 'generated a new encryption key; back it up together with the database');

  const db = openDatabase(config.dbPath);
  const applied = await migrate(db, { backupDir: path.join(config.dataDir, 'backups'), log });
  if (applied.length) log.info({ applied }, 'database migrated');

  const ctx = new AppContext(config, db, box, log);
  ctx.jobs.recoverInterrupted();

  // First-run protection: setup requires a code that is only visible to whoever can read the logs
  // (or JW_SETUP_TOKEN), so nobody else on the network can claim the admin account first.
  let setupCode: string | null = null;
  const userCount = () => (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (userCount() === 0) {
    setupCode = config.setupToken ?? crypto.randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})/, '$1-');
    if (!config.setupToken) log.warn(`First-run setup code: ${setupCode}  (enter it at the setup screen)`);
    else log.warn('First-run setup: use the value of JW_SETUP_TOKEN as the setup code');
  }

  const app = await buildApp(ctx, { setupCode: () => (userCount() === 0 ? setupCode : null) });
  const scheduler = new Scheduler(ctx);
  if (!config.disableScheduler) scheduler.start();

  await app.listen({ host: config.host, port: config.port });
  log.info({ host: config.host, port: config.port }, 'listening');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    scheduler.stop();
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await app.close();
    } finally {
      db.close();
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
