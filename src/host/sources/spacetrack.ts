/**
 * Space-Track.org — authenticated aggregator, enabled only with a login.
 *
 * Set `SPACETRACK_IDENTITY` / `SPACETRACK_PASSWORD` in `.env` (see `.env.example`).
 * Without them this source is inert (discover returns []). It is intended for
 * operators that publish NO upstream public feed (Kuiper, Iridium, ORBCOMM, AST);
 * the object-name patterns are configurable via `SPACETRACK_GROUPS`.
 *
 * Discovery logs in (POST /ajaxauth/login), captures the session cookie, and
 * returns one GP (general-perturbations / OMM) query resource per pattern, with
 * the cookie forwarded on each fetch.
 */
import type { DiscoveredResource } from '../types.js';
import type { EphemerisSource, SourceContext } from './index.js';
import { spaceTrackCredentials } from '../env.js';
import { childLogger } from '../logger.js';

const log = childLogger({ component: 'source:spacetrack' });

function extractCookie(headers: Record<string, string>): string | null {
  const raw = headers['set-cookie'] ?? headers['Set-Cookie'];
  if (!raw) return null;
  // We only need the first cookie pair (Space-Track sets `chocolatechip`).
  const first = raw.split(/,(?=[^;]+=)/)[0] ?? raw;
  return first.split(';')[0]?.trim() ?? null;
}

export const spaceTrackSource: EphemerisSource = {
  id: 'space-track',
  name: 'Space-Track (login)',
  operator: 'Space-Track.org / 18th SDS',
  parserTag: 'omm-gp',
  contentExt: 'json',
  host: 'www.space-track.org',

  async discover(ctx: SourceContext): Promise<DiscoveredResource[]> {
    const creds = spaceTrackCredentials();
    if (!creds) {
      log.warn('SPACETRACK_IDENTITY/PASSWORD not set — skipping Space-Track (add them to .env)');
      return [];
    }

    const body =
      `identity=${encodeURIComponent(creds.identity)}` +
      `&password=${encodeURIComponent(creds.password)}`;
    const loginRes = await ctx.http.post(`${creds.baseUrl}/ajaxauth/login`, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!loginRes.ok) {
      throw new Error(`Space-Track login failed: HTTP ${loginRes.status}`);
    }
    const cookie = extractCookie(loginRes.headers);
    if (!cookie) {
      throw new Error(
        'Space-Track login returned no session cookie (set-cookie not exposed by the http capability)',
      );
    }

    const patterns = (process.env.SPACETRACK_GROUPS?.trim() ||
      'KUIPER,IRIDIUM,ORBCOMM,BLUEWALKER,BLUEBIRD')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const limited = ctx.limit ? patterns.slice(0, ctx.limit) : patterns;
    const headers = { Cookie: cookie, Accept: 'application/json' };

    return limited.map((pattern): DiscoveredResource => ({
      id: `gp_${pattern}.json`,
      url:
        `${creds.baseUrl}/basicspacedata/query/class/gp/OBJECT_NAME/~~${encodeURIComponent(pattern)}` +
        `/orderby/NORAD_CAT_ID%20asc/format/json`,
      noradId: null,
      ext: 'json',
      headers,
      hints: { satelliteName: `Space-Track GP: ${pattern}` },
    }));
  },
};
