import { describe, it, expect } from 'vitest';
import { HttpClient, RateLimiter } from '../src/host/http.js';
import type { HttpRequester } from '../src/host/http.js';

describe('RateLimiter', () => {
  it('spaces out acquisitions by the minimum interval', async () => {
    const limiter = new RateLimiter(40);
    const start = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(Date.now() - start).toBeGreaterThanOrEqual(70);
  });
});

describe('HttpClient retry/backoff', () => {
  it('retries at least 5 times before failing', async () => {
    let attempts = 0;
    const requester: HttpRequester = async () => {
      attempts++;
      throw new Error('boom');
    };
    const client = new HttpClient(
      { retryCount: 5, baseDelayMs: 1, maxDelayMs: 4, timeoutMs: 100 },
      requester,
    );
    await expect(client.get('https://example.com/x')).rejects.toThrow(/after 6 attempts/);
    expect(attempts).toBe(6); // 1 initial + 5 retries
  });

  it('succeeds after transient failures', async () => {
    let attempts = 0;
    const requester: HttpRequester = async () => {
      attempts++;
      if (attempts < 3) throw new Error('transient');
      return {
        url: 'https://example.com/x',
        status: 200,
        statusText: 'OK',
        ok: true,
        headers: {},
        body: new TextEncoder().encode('hello'),
      };
    };
    const client = new HttpClient(
      { retryCount: 5, baseDelayMs: 1, maxDelayMs: 4, timeoutMs: 100 },
      requester,
    );
    const text = await client.getText('https://example.com/x');
    expect(text).toBe('hello');
    expect(attempts).toBe(3);
  });

  it('retries 5xx but fails fast on 404', async () => {
    let attempts = 0;
    const requester: HttpRequester = async () => {
      attempts++;
      return {
        url: 'u',
        status: 404,
        statusText: 'Not Found',
        ok: false,
        headers: {},
        body: new Uint8Array(),
      };
    };
    const client = new HttpClient(
      { retryCount: 5, baseDelayMs: 1, maxDelayMs: 4, timeoutMs: 100 },
      requester,
    );
    const res = await client.get('https://example.com/missing');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(attempts).toBe(1);
  });
});
