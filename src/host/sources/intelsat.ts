/**
 * Intelsat — operator-published ephemerides (own domain my.intelsat.com).
 * The public index lists files as <option value="…"> entries; the `_e_` files
 * are ECF state-vector ephemerides served from /Resource/Ephemeris/<name>.txt.
 *   i_<region>_e_<lon>_<sat>_<date>_<time>   ← ECF ephemeris (fetched here)
 *   i_<region>_c_…  center-of-box, i_<region>_m_…  11-parameter maneuver
 */
import type { DiscoveredResource } from '../types.js';
import type { EphemerisSource, SourceContext } from './index.js';
import { scrapeOptionValues } from './util.js';

const INDEX = 'https://my.intelsat.com/ephemeris/public';
const BASE = 'https://my.intelsat.com/Resource/Ephemeris/';

export const intelsatSource: EphemerisSource = {
  id: 'intelsat',
  name: 'Intelsat',
  operator: 'Intelsat',
  parserTag: 'intelsat-ecf',
  contentExt: 'txt',
  host: 'my.intelsat.com',

  async discover(ctx: SourceContext): Promise<DiscoveredResource[]> {
    const html = await ctx.http.getText(INDEX);
    const ephemerisFiles = scrapeOptionValues(html).filter((v) => /_e_/.test(v));
    const unique = [...new Set(ephemerisFiles)];
    const limited = ctx.limit ? unique.slice(0, ctx.limit) : unique;
    return limited.map((value): DiscoveredResource => {
      const sat = value.split('_')[4] ?? value;
      return {
        id: `${value}.txt`,
        url: `${BASE}${value}.txt`,
        noradId: null,
        ext: 'txt',
        hints: { satelliteName: `Intelsat ${sat.toUpperCase()}` },
      };
    });
  },
};
