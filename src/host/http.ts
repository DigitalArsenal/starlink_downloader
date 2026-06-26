/**
 * Network layer.
 *
 * All network egress goes through the SDK's **isomorphic `http` capability**
 * (`createNodeHost` -> `http.request`), which maps to fetch/undici in Node and
 * a host shim under WasmEdge — the same callout a guest module would make. On
 * top of it we add the cross-cutting policy the GOAL requires: at least five
 * retries with exponential backoff + jitter, per-host rate limiting, and
 * per-request timeouts.
 */
import { createNodeHost, type HttpRequestParams, type HttpResponse } from 'space-data-module-sdk';
import { childLogger } from './logger.js';

/** A request function with the SDK http capability shape (injectable for tests). */
export type HttpRequester = (params: HttpRequestParams) => Promise<HttpResponse>;

const log = childLogger({ component: 'http' });

export interface HttpResult {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** Always returned as bytes; callers decode as needed. */
  bytes: Uint8Array;
  url: string;
}

export interface SendOptions extends Partial<RetryOptions> {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | null;
}

export interface RetryOptions {
  /** Number of *retries* after the first attempt (>= 5 per the GOAL). */
  retryCount: number;
  /** Base backoff in ms (grows ~2^n with jitter). */
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
}

export const DEFAULT_RETRY: RetryOptions = {
  retryCount: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  timeoutMs: 60_000,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A simple minimum-interval rate limiter (per host). */
export class RateLimiter {
  private next = 0;
  constructor(private readonly minIntervalMs: number) {}

  async acquire(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    const wait = Math.max(0, this.next - now);
    this.next = Math.max(now, this.next) + this.minIntervalMs;
    if (wait > 0) await sleep(wait);
  }
}

function toBytes(body: HttpResponse['body']): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body && typeof body === 'object') return new TextEncoder().encode(JSON.stringify(body));
  return new Uint8Array(0);
}

/** Wraps the SDK isomorphic http capability with retry/backoff + rate limiting. */
export class HttpClient {
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly request: HttpRequester;

  /**
   * @param defaults retry/backoff/timeout policy
   * @param requester optional override (defaults to the SDK isomorphic http
   *        capability via `createNodeHost`); injected in tests.
   */
  constructor(
    private readonly defaults: RetryOptions = DEFAULT_RETRY,
    requester?: HttpRequester,
  ) {
    if (requester) {
      this.request = requester;
    } else {
      const host = createNodeHost({ capabilities: ['http'] });
      this.request = (params) => host.invoke('http.request', params) as Promise<HttpResponse>;
    }
  }

  /** Configure a minimum interval (ms) between requests to a host. */
  setRateLimit(host: string, minIntervalMs: number): void {
    this.limiters.set(host, new RateLimiter(minIntervalMs));
  }

  private limiterFor(url: string): RateLimiter | undefined {
    try {
      return this.limiters.get(new URL(url).host);
    } catch {
      return undefined;
    }
  }

  /**
   * Send a request as bytes, retrying with exponential backoff + jitter.
   * Honors custom method/headers/body so callers can do auth (Bearer headers,
   * cookie-based logins, POST form bodies).
   */
  async send(opts: SendOptions): Promise<HttpResult> {
    const o = { ...this.defaults, ...opts };
    const { url } = opts;
    const limiter = this.limiterFor(url);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= o.retryCount; attempt++) {
      if (limiter) await limiter.acquire();
      try {
        const res = await this.request({
          url,
          method: opts.method ?? 'GET',
          ...(opts.headers ? { headers: opts.headers } : {}),
          ...(opts.body !== undefined ? { body: opts.body } : {}),
          responseType: 'bytes',
          timeoutMs: o.timeoutMs,
        });
        if (!res.ok) {
          if (res.status === 429 || res.status >= 500) {
            throw new Error(`HTTP ${res.status} ${res.statusText}`);
          }
          return { status: res.status, ok: false, headers: res.headers, bytes: toBytes(res.body), url };
        }
        return { status: res.status, ok: true, headers: res.headers, bytes: toBytes(res.body), url };
      } catch (err) {
        lastErr = err;
        if (attempt === o.retryCount) break;
        const backoff = Math.min(o.maxDelayMs, o.baseDelayMs * 2 ** attempt);
        const jitter = backoff * (0.5 + Math.random() * 0.5);
        log.warn(
          { url, attempt: attempt + 1, of: o.retryCount, delayMs: Math.round(jitter), err: String(err) },
          'http retry',
        );
        await sleep(jitter);
      }
    }
    throw new Error(`${opts.method ?? 'GET'} ${url} failed after ${o.retryCount + 1} attempts: ${String(lastErr)}`);
  }

  /** GET a URL as bytes. */
  async get(url: string, opts: Partial<RetryOptions> & { headers?: Record<string, string> } = {}): Promise<HttpResult> {
    return this.send({ url, method: 'GET', ...opts });
  }

  /** POST a body (e.g. a form login) as bytes. */
  async post(
    url: string,
    body: string | Uint8Array,
    opts: Partial<RetryOptions> & { headers?: Record<string, string> } = {},
  ): Promise<HttpResult> {
    return this.send({ url, method: 'POST', body, ...opts });
  }

  /** GET and decode as UTF-8 text. */
  async getText(url: string, opts: Partial<RetryOptions> & { headers?: Record<string, string> } = {}): Promise<string> {
    const r = await this.get(url, opts);
    if (!r.ok) throw new Error(`GET ${url} -> HTTP ${r.status}`);
    return new TextDecoder('utf-8').decode(r.bytes);
  }
}
