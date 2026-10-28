import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app.js';
import { ApiError } from '../http/errors.js';
import { safeEqual } from '../security/crypto.js';
import { triggerJob } from '../sync/scheduler.js';
import { webhookToken } from './integrations.js';

/**
 * Optional push notifications from Seerr (Webhook agent) and Jellyfin (Webhook plugin).
 * The payload is never trusted for state: a valid call only schedules a sync that reads the
 * authoritative API. Calls are authenticated with a shared token in the Authorization header.
 */
export async function webhookRoutes(app: FastifyInstance, { ctx }: AppDeps) {
  const authorize = (req: FastifyRequest) => {
    const header = req.headers.authorization ?? '';
    const token = header.replace(/^Bearer\s+/i, '').trim();
    if (!token || !safeEqual(token, webhookToken(ctx))) throw new ApiError(401, 'unauthorized', 'Invalid webhook token.');
  };
  const debounce = new Map<string, NodeJS.Timeout>();
  const schedule = (job: 'seerr' | 'jellyfin') => {
    // Bursts of events (e.g. a season import) collapse into one sync.
    clearTimeout(debounce.get(job));
    debounce.set(job, setTimeout(() => void triggerJob(ctx, job, 'event'), job === 'jellyfin' ? 30_000 : 5_000));
  };

  const limit = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };
  app.post('/webhooks/seerr', limit, async (req) => {
    authorize(req);
    schedule('seerr');
    return { ok: true };
  });

  app.post('/webhooks/jellyfin', limit, async (req) => {
    authorize(req);
    schedule('jellyfin');
    return { ok: true };
  });
}
