import { z } from 'zod';
import { HttpClient, type FetchLike } from '../http/client.js';

/**
 * Home Assistant REST API adapter (Janitor notifications). Base {url}/api, Bearer long-lived token.
 *  - GET /api/ answers {"message":"API running."}
 *  - GET /api/services lists domains and their services
 *  - POST /api/services/notify/{service} sends a notification (mobile_app_*, persistent_notification, …)
 */
export class HomeAssistantClient {
  readonly http: HttpClient;

  constructor(
    baseUrl: string,
    token: string,
    private readonly service: string,
    fetchImpl?: FetchLike,
  ) {
    this.http = new HttpClient({
      provider: 'homeassistant',
      baseUrl: `${baseUrl.replace(/\/+$/, '')}/api`,
      headers: () => ({ Authorization: `Bearer ${token}` }),
      timeoutMs: 15_000,
      fetchImpl,
    });
  }

  async ping(): Promise<string> {
    const res = await this.http.get('/');
    return z.object({ message: z.string() }).parse(res.data).message;
  }

  /** Notify services Home Assistant offers (without the "notify." prefix). */
  async notifyServices(): Promise<string[]> {
    const res = await this.http.get('/services');
    const list = z.array(z.object({ domain: z.string(), services: z.record(z.string(), z.unknown()) })).parse(res.data);
    return Object.keys(list.find((d) => d.domain === 'notify')?.services ?? {});
  }

  async notify(msg: { title: string; message: string; url?: string | null }): Promise<void> {
    const data = msg.url ? { url: msg.url, clickAction: msg.url } : undefined;
    await this.http.post(`/services/notify/${encodeURIComponent(this.service)}`, { title: msg.title, message: msg.message, ...(data ? { data } : {}) });
  }
}
