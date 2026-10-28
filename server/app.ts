import fs from 'node:fs';
import path from 'node:path';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { AppContext } from './context.js';
import { ApiError, ProviderError } from './http/errors.js';
import { scrub } from './logger.js';
import { registerAuth, SessionService } from './security/auth.js';
import { UserService } from './services/users.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { integrationRoutes } from './routes/integrations.js';
import { sourceRoutes } from './routes/sources.js';
import { catalogRoutes } from './routes/catalog.js';
import { imageRoutes } from './routes/images.js';
import { webhookRoutes } from './routes/webhooks.js';

export interface AppDeps {
  ctx: AppContext;
  users: UserService;
  sessions: SessionService;
  setupCode: () => string | null;
}

export async function buildApp(ctx: AppContext, opts: { setupCode: () => string | null; serveWeb?: boolean } ): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log.child({ component: 'http' }) as unknown as FastifyBaseLogger,
    trustProxy: ctx.config.trustProxy,
    bodyLimit: 1024 * 1024,
    // Per-request logging is done in onResponse below without headers or query strings.
    logController: new LogController({ disableRequestLogging: true }),
    routerOptions: { ignoreTrailingSlash: true },
  });

  app.addHook('onResponse', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/images/')) return;
    req.log.info({ method: req.method, path: req.url.split('?')[0], status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'request');
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
      },
    },
    // HSTS only makes sense behind TLS; leave it to the reverse proxy.
    strictTransportSecurity: false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 10 } });

  const users = new UserService(ctx.db);
  const sessions = new SessionService(ctx, ctx.config.sessionTtlDays);
  registerAuth(app, ctx, sessions);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ProviderError) {
      req.log.warn({ provider: err.provider, kind: err.kind, status: err.status }, 'provider error');
      const status = err.kind === 'not_found' ? 404 : err.kind === 'bad_request' || err.kind === 'config' ? 400 : 502;
      return reply.status(status).send({ error: { code: `${err.provider}_${err.kind}`, message: err.message, provider: err.provider } });
    }
    const e = err as { statusCode?: number; code?: string; message?: string; validation?: unknown };
    if (e.statusCode === 429) return reply.status(429).send({ error: { code: 'rate_limited', message: 'Too many attempts. Wait a minute and try again.' } });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: scrub(e.message ?? 'Bad request') } });
    }
    req.log.error({ err: scrub(String(e.message ?? err)) }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong on the server. Check the JellyWatcher logs for details.' } });
  });

  app.get('/health', async () => {
    ctx.db.prepare('SELECT 1').get();
    return { status: 'ok', version: ctx.config.version };
  });

  const deps: AppDeps = { ctx, users, sessions, setupCode: opts.setupCode };
  await app.register(async (api) => {
    await authRoutes(api, deps);
    await adminRoutes(api, deps);
    await integrationRoutes(api, deps);
    await sourceRoutes(api, deps);
    await catalogRoutes(api, deps);
    await imageRoutes(api, deps);
    await webhookRoutes(api, deps);
  }, { prefix: '/api' });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.method !== 'GET') {
      return reply.status(404).send({ error: { code: 'not_found', message: 'Not found.' } });
    }
    if (opts.serveWeb !== false && fs.existsSync(path.join(ctx.config.webDir, 'index.html'))) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.status(404).type('text/plain').send('Web UI not built. Run `npm run build:web`.');
  });

  if (opts.serveWeb !== false && fs.existsSync(ctx.config.webDir)) {
    await app.register(fastifyStatic, {
      root: ctx.config.webDir,
      wildcard: false,
      index: ['index.html'],
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
        else res.header('Cache-Control', 'no-cache');
      },
    });
  }

  return app;
}
