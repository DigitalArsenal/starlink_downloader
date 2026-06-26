/**
 * Spire Global orbit API (https://api.orb.spire.com) — requires an API key.
 *
 * Set `SPIRE_API_KEY` in `.env` (see `.env.example`). Without it this source is
 * inert (discover returns []). Endpoints are configurable via `SPIRE_ENDPOINTS`
 * (comma-separated paths; default `/ephemeris,/tle`). Auth is `Authorization:
 * Bearer <key>`, forwarded on each resource fetch.
 */
import type { DiscoveredResource } from '../types.js';
import type { EphemerisSource, SourceContext } from './index.js';
import { spireCredentials } from '../env.js';
import { childLogger } from '../logger.js';

const log = childLogger({ component: 'source:spire' });

export const spireSource: EphemerisSource = {
  id: 'spire',
  name: 'Spire Global (API key)',
  operator: 'Spire Global',
  parserTag: 'spire',
  contentExt: 'json',
  host: 'api.orb.spire.com',

  async discover(_ctx: SourceContext): Promise<DiscoveredResource[]> {
    const creds = spireCredentials();
    if (!creds) {
      log.warn('SPIRE_API_KEY not set — skipping Spire (add it to .env to enable)');
      return [];
    }
    const endpoints = (process.env.SPIRE_ENDPOINTS?.trim() || '/ephemeris,/tle')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const headers = { Authorization: `Bearer ${creds.apiKey}`, Accept: 'application/json' };
    return endpoints.map((path): DiscoveredResource => {
      const ext = path.includes('tle') ? 'tle' : 'json';
      return {
        id: path.replace(/^\//, '').replace(/\//g, '_') || 'root',
        url: `${creds.baseUrl}${path}`,
        noradId: null,
        ext,
        headers,
        hints: { satelliteName: `Spire ${path}` },
      };
    });
  },
};
