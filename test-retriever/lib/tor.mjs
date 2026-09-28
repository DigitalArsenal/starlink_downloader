import { execFile } from 'node:child_process';

// CelesTrak over Tor, for FIREWALL RECOVERY ONLY. This network has been
// blocked by CelesTrak's firewall for reasons unrelated to our request
// behavior (TCP 443 times out from the owner's address). Tor restores
// reachability; it is not a rate-limit workaround. Every rule in
// space-data-network-modules analysis/conjunction-assessment/scripts/
// CELESTRAK_FETCH_POLICY.md still applies unchanged: the Celestrak client
// keeps its serial 2.5 s pacing, its 3-hour URL ledger, its 60 s backoff with
// one retry, and its 30-failure abort, whatever the transport.
//
// Needs a local Tor SOCKS proxy (brew services start tor); set
// TEST_RETRIEVER_TOR_SOCKS to override 127.0.0.1:9050.
export const DEFAULT_SOCKS = '127.0.0.1:9050';

export function curlArgs(url, socks = process.env.TEST_RETRIEVER_TOR_SOCKS || DEFAULT_SOCKS) {
  return ['-sS', '--socks5-hostname', socks, '--max-time', '60', '-o', '-', '-w', '\n%{http_code}', url];
}

export function torFetch(url, { signal, run = execFile } = {}) {
  return new Promise((resolve, reject) => {
    const child = run('curl', curlArgs(url), { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new Error(`Tor transport failed: ${error.message.split('\n')[0]}`));
        return;
      }
      const cut = stdout.lastIndexOf(0x0a);
      const status = Number(stdout.subarray(cut + 1).toString('utf8'));
      if (!Number.isInteger(status) || status < 100) {
        reject(new Error('Tor transport returned no HTTP status'));
        return;
      }
      resolve(new Response(status === 204 || status === 304 ? null : stdout.subarray(0, cut), { status }));
    });
    signal?.addEventListener('abort', () => child.kill(), { once: true });
  });
}
