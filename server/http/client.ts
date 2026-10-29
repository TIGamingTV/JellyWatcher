import { scrub } from '../logger.js';
import { ProviderError, kindForStatus } from './errors.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  provider: string;
  baseUrl: string;
  /** Headers added to every request (evaluated per request so tokens can rotate). */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  timeoutMs?: number;
  retries?: number;
  /** Minimum spacing between request starts, a simple client-side rate limit. */
  minIntervalMs?: number;
  fetchImpl?: FetchLike;
  userAgent?: string;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Retry count override. Non-GET requests are not retried unless set explicitly. */
  retries?: number;
  /** Status codes that should be returned instead of thrown. */
  acceptStatus?: number[];
  responseType?: 'json' | 'text' | 'buffer';
}

export interface HttpResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const USER_AGENT = 'JellyWatcher/0.6 (+self-hosted)';

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export function backoffDelay(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, 60_000);
  const base = Math.min(15_000, 500 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

export class HttpClient {
  private readonly opts: Required<Omit<HttpClientOptions, 'headers' | 'fetchImpl'>> &
    Pick<HttpClientOptions, 'headers'> & { fetchImpl: FetchLike };
  private queue: Promise<void> = Promise.resolve();
  private lastStart = 0;

  constructor(options: HttpClientOptions) {
    this.opts = {
      timeoutMs: 15_000,
      retries: 2,
      minIntervalMs: 0,
      userAgent: USER_AGENT,
      ...options,
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
      fetchImpl: options.fetchImpl ?? ((input, init) => fetch(input, init)),
    };
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  private async throttle(): Promise<void> {
    if (!this.opts.minIntervalMs) return;
    const turn = this.queue.then(async () => {
      const wait = this.lastStart + this.opts.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastStart = Date.now();
    });
    this.queue = turn.catch(() => undefined);
    await turn;
  }

  /**
   * Appends query parameters without re-serialising a query string that is already part of `path`.
   * (URLSearchParams would rewrite `%20` as `+`, which Seerr's API validator rejects as a reserved
   * character.) Values are percent-encoded, so spaces become `%20`.
   */
  buildUrl(path: string, query?: RequestOptions['query']): string {
    const base = this.opts.baseUrl + (path.startsWith('/') ? path : `/${path}`);
    const extra = Object.entries(query ?? {})
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    if (extra.length === 0) return new URL(base).toString();
    const [beforeHash, hash] = base.split('#', 2) as [string, string | undefined];
    const sep = beforeHash.includes('?') ? (beforeHash.endsWith('?') || beforeHash.endsWith('&') ? '' : '&') : '?';
    return new URL(`${beforeHash}${sep}${extra.join('&')}${hash !== undefined ? `#${hash}` : ''}`).toString();
  }

  async request<T = unknown>(req: RequestOptions): Promise<HttpResponse<T>> {
    const method = req.method ?? 'GET';
    const maxRetries = req.retries ?? (method === 'GET' ? this.opts.retries : 0);
    const url = this.buildUrl(req.path, req.query);
    let attempt = 0;

    for (;;) {
      await this.throttle();
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': this.opts.userAgent,
        ...(this.opts.headers ? await this.opts.headers() : {}),
        ...req.headers,
      };
      let body: string | undefined;
      if (req.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(req.body);
      }

      let res: Response;
      try {
        res = await this.send(url, { method, headers, body, signal: AbortSignal.timeout(req.timeoutMs ?? this.opts.timeoutMs) });
      } catch (cause) {
        if (cause instanceof ProviderError) throw cause;
        const isTimeout = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
        const err = new ProviderError(this.opts.provider, isTimeout ? 'timeout' : 'network', undefined, { cause });
        if (attempt < maxRetries) {
          await sleep(backoffDelay(attempt++));
          continue;
        }
        throw err;
      }

      if (res.ok || req.acceptStatus?.includes(res.status)) {
        return { status: res.status, data: await this.readBody<T>(res, req.responseType ?? 'json'), headers: res.headers };
      }

      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      const kind = kindForStatus(res.status);
      const errBody = await res.text().catch(() => '');
      let parsed: unknown = errBody;
      try {
        parsed = errBody ? JSON.parse(errBody) : undefined;
      } catch {
        /* keep text */
      }
      const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
      if (retryable && attempt < maxRetries) {
        await sleep(backoffDelay(attempt++, retryAfterMs));
        continue;
      }
      throw new ProviderError(this.opts.provider, kind, undefined, {
        status: res.status,
        retryAfterMs,
        body: typeof parsed === 'string' ? scrub(parsed.slice(0, 500)) : parsed,
      });
    }
  }

  /**
   * Clients with credential headers (API keys, tokens) follow redirects themselves and only to the
   * same server (an http → https upgrade included): fetch would pass headers like X-Api-Key on to any
   * other host. Clients without credentials follow redirects normally (e.g. boxd.it short links).
   */
  private async send(url: string, init: RequestInit & { method: string; headers: Record<string, string> }): Promise<Response> {
    if (!this.opts.headers) return this.opts.fetchImpl(url, { ...init, redirect: 'follow' });
    let current = new URL(url);
    let { method, body } = init;
    for (let hop = 0; ; hop++) {
      const res = await this.opts.fetchImpl(current.toString(), { ...init, method, body, redirect: 'manual' });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) return res;
      await res.body?.cancel().catch(() => undefined);
      const next = new URL(location, current);
      if (hop >= 5 || !sameServer(current, next)) {
        throw new ProviderError(this.opts.provider, 'invalid_response', 'The service redirected to another address. Enter the final address (including http or https) in its settings.', { status: res.status });
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      current = next;
    }
  }

  private async readBody<T>(res: Response, type: 'json' | 'text' | 'buffer'): Promise<T> {
    if (type === 'buffer') return Buffer.from(await res.arrayBuffer()) as T;
    const text = await res.text();
    if (type === 'text') return text as T;
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new ProviderError(this.opts.provider, 'invalid_response', undefined, { status: res.status, cause });
    }
  }

  get<T = unknown>(path: string, query?: RequestOptions['query'], extra: Partial<RequestOptions> = {}) {
    return this.request<T>({ ...extra, method: 'GET', path, query });
  }

  post<T = unknown>(path: string, body?: unknown, extra: Partial<RequestOptions> = {}) {
    return this.request<T>({ ...extra, method: 'POST', path, body });
  }
}

function sameServer(from: URL, to: URL): boolean {
  if (from.hostname !== to.hostname) return false;
  if (from.protocol === to.protocol) return from.port === to.port;
  return from.protocol === 'http:' && to.protocol === 'https:';
}

/**
 * Validates and normalises a user-provided service URL. Private addresses are allowed on purpose
 * (homelab services usually live on the LAN), but only http(s) without embedded credentials.
 */
export function normalizeServiceUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Enter a full URL including http:// or https://');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http:// and https:// URLs are supported.');
  if (url.username || url.password) throw new Error('Do not include a username or password in the URL.');
  if (url.search || url.hash) throw new Error('Remove query parameters and fragments from the URL.');
  return url.toString().replace(/\/+$/, '');
}
