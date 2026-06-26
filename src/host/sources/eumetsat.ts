/**
 * EUMETSAT — operator TLE service (anonymous, no auth).
 * Upstream: https://service.eumetsat.int/tle/ — per-satellite TLE data embedded
 * in `javascript/data_content_<id>.js` files (Metop, NOAA/JPSS, Sentinel-3/6,
 * Metop-SG). Discovery scrapes the index for the current satellite set.
 */
import type { DiscoveredResource } from '../types.js';
import type { EphemerisSource, SourceContext } from './index.js';
import { scrapeHrefs } from './util.js';

const BASE = 'https://service.eumetsat.int/tle';

const NAMES: Record<string, string> = {
  m01: 'Metop-B',
  m02: 'Metop-A',
  m03: 'Metop-C',
  n20: 'NOAA-20',
  n21: 'NOAA-21',
  npp: 'Suomi-NPP',
  s3a: 'Sentinel-3A',
  s3b: 'Sentinel-3B',
  s6a: 'Sentinel-6 Michael Freilich',
  sga1: 'Metop-SG-A1',
};

export const eumetsatSource: EphemerisSource = {
  id: 'eumetsat',
  name: 'EUMETSAT',
  operator: 'EUMETSAT',
  parserTag: 'eumetsat-tle',
  contentExt: 'js',
  host: 'service.eumetsat.int',

  async discover(ctx: SourceContext): Promise<DiscoveredResource[]> {
    const html = await ctx.http.getText(`${BASE}/`);
    const ids = [
      ...new Set(
        scrapeHrefs(html)
          .concat([...html.matchAll(/src="([^"]+data_content_[a-z0-9]+\.js)"/gi)].map((m) => m[1]!))
          .map((h) => h.match(/data_content_([a-z0-9]+)\.js/i)?.[1])
          .filter((v): v is string => Boolean(v)),
      ),
    ];
    const limited = ctx.limit ? ids.slice(0, ctx.limit) : ids;
    return limited.map((id): DiscoveredResource => ({
      id: `data_content_${id}.js`,
      url: `${BASE}/javascript/data_content_${id}.js`,
      noradId: null,
      ext: 'js',
      hints: { satelliteName: NAMES[id] ?? `EUMETSAT ${id.toUpperCase()}` },
    }));
  },
};
