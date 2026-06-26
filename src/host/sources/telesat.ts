/**
 * Telesat — operator-published prediction data (own domain app.telesat.com).
 * Manifest `FleetLong.csv` lists the fleet; per-satellite `<Sat>.C.csv` holds
 * center-of-box predictions. (Full state vectors are not publicly exposed.)
 */
import type { DiscoveredResource } from '../types.js';
import type { EphemerisSource, SourceContext } from './index.js';

const BASE = 'https://app.telesat.com/data';

export const telesatSource: EphemerisSource = {
  id: 'telesat',
  name: 'Telesat',
  operator: 'Telesat',
  parserTag: 'telesat-cob',
  contentExt: 'csv',
  host: 'app.telesat.com',

  async discover(ctx: SourceContext): Promise<DiscoveredResource[]> {
    const csv = await ctx.http.getText(`${BASE}/FleetLong.csv`);
    const sats = csv
      .split('\n')
      .slice(1) // first line is a UTC generation timestamp
      .map((l) => l.split(',')[0]?.trim())
      .filter((s): s is string => Boolean(s));
    const unique = [...new Set(sats)];
    const limited = ctx.limit ? unique.slice(0, ctx.limit) : unique;
    return limited.map((sat): DiscoveredResource => ({
      id: `${sat}.C.csv`,
      url: `${BASE}/${sat}.C.csv`,
      noradId: null,
      ext: 'csv',
      hints: { satelliteName: `Telesat ${sat}` },
    }));
  },
};
