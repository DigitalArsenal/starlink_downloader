import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Networking only. Never spool response bodies to disk or log their contents.
export async function fetchMemory(url, { source, range, fetchImpl = fetch, wait = sleep } = {}) {
  const started = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetchImpl(url, {
      headers: range ? { Range: `bytes=0-${range - 1}` } : {},
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 429 && attempt < 2) {
      await response.body?.cancel();
      const retry = response.headers.get('retry-after');
      const delay = /^\d+$/.test(retry ?? '') ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      await wait(Math.max(1000 * 2 ** attempt, Number.isFinite(delay) ? delay : 0));
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}: ${url}`);
    }
    if (range && (response.status !== 206 || !response.headers.get('content-range')?.startsWith('bytes 0-'))) {
      await response.body?.cancel();
      throw new Error(`Range request not honored: ${url}`);
    }
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > (range ?? 128 * 1024 * 1024)) throw new Error(`Response exceeds in-memory byte bound: ${url}`);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    return { bytes, provenance: {
      source, url, status: response.status, etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'), sha256: sha256(bytes),
      fetchedAt: new Date().toISOString(), fetchMs: Date.now() - started, byteLength: bytes.length,
    } };
  }
}
export async function mapBounded(items, concurrency, consume) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; await consume(items[index], index); }
  }));
}
