export type ProviderErrorKind =
  | 'config'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'bad_request'
  | 'rate_limited'
  | 'unavailable'
  | 'timeout'
  | 'network'
  | 'invalid_response';

const DEFAULT_MESSAGES: Record<ProviderErrorKind, string> = {
  config: 'The integration is not configured.',
  auth: 'The credentials were rejected. Check the API key or reconnect the account.',
  forbidden: 'The account does not have permission for this action.',
  not_found: 'The requested item was not found.',
  conflict: 'The request conflicts with existing data.',
  bad_request: 'The service rejected the request.',
  rate_limited: 'The service is rate limiting requests. Sync will retry later.',
  unavailable: 'The service is temporarily unavailable.',
  timeout: 'The service did not respond in time.',
  network: 'The server could not be reached. Check the address and that it is reachable from the JellyWatcher container.',
  invalid_response: 'The service returned data in an unexpected format.',
};

/** Error raised by integration adapters. Messages are safe to show to users (no secrets). */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly body: unknown;

  constructor(
    provider: string,
    kind: ProviderErrorKind,
    message?: string,
    extra: { status?: number; retryAfterMs?: number; body?: unknown; cause?: unknown } = {},
  ) {
    super(message ?? DEFAULT_MESSAGES[kind], { cause: extra.cause });
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind;
    this.status = extra.status;
    this.retryAfterMs = extra.retryAfterMs;
    this.body = extra.body;
  }

  get retryable(): boolean {
    return ['rate_limited', 'unavailable', 'timeout', 'network'].includes(this.kind);
  }
}

export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'unavailable';
  return 'bad_request';
}

/** HTTP error surfaced by our own API with a stable machine code. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ProviderError || err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
