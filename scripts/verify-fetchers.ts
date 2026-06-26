/**
 * Smoke-test every source fetcher: run discover() and download the first
 * resource from each upstream feed. Live network. Run: `npx tsx scripts/verify-fetchers.ts`.
 */
import { listSources } from '../src/host/sources/index.js';
import { HttpClient } from '../src/host/http.js';

const http = new HttpClient();
let ok = 0;
for (const src of listSources()) {
  const t0 = Date.now();
  try {
    const resources = await src.discover({ http, limit: 3 });
    if (resources.length === 0) {
      console.log(`✗ ${src.id.padEnd(18)} discover returned 0 resources`);
      continue;
    }
    const first = resources[0]!;
    const res = await http.get(first.url, { retryCount: 2, timeoutMs: 30_000 });
    const dt = Date.now() - t0;
    if (res.ok) ok++;
    console.log(
      `${res.ok ? '✓' : '✗'} ${src.id.padEnd(18)} discovered=${String(resources.length).padEnd(4)} ` +
        `fetch[${res.status}] ${String(res.bytes.length).padStart(8)}b ${dt}ms  ${first.id}`,
    );
  } catch (e) {
    console.log(`✗ ${src.id.padEnd(18)} ERROR ${String(e).slice(0, 120)}`);
  }
}
console.log(`\n${ok}/${listSources().length} fetchers working`);
