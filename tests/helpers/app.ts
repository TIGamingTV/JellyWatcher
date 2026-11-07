import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../server/app';
import { loadConfig } from '../../server/config';
import { AppContext } from '../../server/context';
import { migrate, openDatabase } from '../../server/db/index';
import { SecretBox } from '../../server/security/crypto';

/** A cookie- and CSRF-aware client for app.inject. */
export class Client {
  cookie = '';
  csrf = '';
  constructor(private readonly app: FastifyInstance) {}
  async req(method: string, url: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (method !== 'GET' && this.csrf) headers['x-csrf-token'] = this.csrf;
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const res = await this.app.inject({ method: method as 'GET', url, headers, payload });
    const setCookie = res.headers['set-cookie'];
    const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (first) this.cookie = first.split(';')[0]!;
    let data: any;
    try {
      data = res.body ? JSON.parse(res.body) : undefined;
    } catch {
      data = undefined;
    }
    if (data && typeof data === 'object' && typeof data.csrfToken === 'string') this.csrf = data.csrfToken;
    return { status: res.statusCode, data, body: res.body };
  }
  get = (u: string) => this.req('GET', u);
  post = (u: string, b?: unknown) => this.req('POST', u, b ?? {});
  put = (u: string, b?: unknown) => this.req('PUT', u, b ?? {});
  patch = (u: string, b?: unknown) => this.req('PATCH', u, b ?? {});
  del = (u: string) => this.req('DELETE', u);
}

export const SETUP_CODE = 'ABCDE-12345';

/** A fresh app on an in-memory database; the scheduler is off. */
export async function testApp(env: Record<string, string> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jw-test-'));
  const config = loadConfig({ JW_DATA_DIR: dataDir, JW_LOG_FILE: '0', JW_DISABLE_SCHEDULER: '1', ...env } as NodeJS.ProcessEnv);
  const db = openDatabase(':memory:');
  await migrate(db);
  const ctx = new AppContext(config, db, SecretBox.fromMaterial('b'.repeat(64)), pino({ level: process.env.JW_TEST_LOG ?? 'silent' }));
  const users = () => (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  const app = await buildApp(ctx, { setupCode: () => (users() === 0 ? SETUP_CODE : null), serveWeb: false });
  const close = async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { app, ctx, close };
}

/** Waits until no background job (follow-ups triggered by events) is running. */
export async function settle(ctx: AppContext) {
  for (let i = 0; i < 500 && ctx.jobs.runningJobs().length > 0; i++) await new Promise((r) => setTimeout(r, 10));
}
