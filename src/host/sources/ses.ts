/**
 * SES — operator-published satellite orbital data (public S3 bucket).
 * The SES technical-data page links to per-satellite files in
 * `ses-satellite-orbital-data-public.s3.eu-west-1.amazonaws.com/public/…`:
 *   ephemeris/<CODE>_THRU.I11   (IESS-412 11-parameter ephemeris)  ← fetched here
 *   norad_tle/<CODE>.TLE
 *   centerofbox/<CODE>_MID.TXT
 */
import type { DiscoveredResource } from '../types.js';
import type { EphemerisSource, SourceContext } from './index.js';
import { scrapeHrefs } from './util.js';

const INDEX =
  'https://www.ses.com/network-and-technology/technical-data-and-tools/satellite-orbital-data';
const BUCKET = 'ses-satellite-orbital-data-public';

export const sesSource: EphemerisSource = {
  id: 'ses',
  name: 'SES',
  operator: 'SES S.A.',
  parserTag: 'ses-i11',
  contentExt: 'i11',
  host: 'ses-satellite-orbital-data-public.s3.eu-west-1.amazonaws.com',

  async discover(ctx: SourceContext): Promise<DiscoveredResource[]> {
    const html = await ctx.http.getText(INDEX);
    const links = scrapeHrefs(html).filter(
      (h) => h.includes(BUCKET) && h.includes('/ephemeris/') && h.endsWith('.I11'),
    );
    const unique = [...new Set(links)];
    const limited = ctx.limit ? unique.slice(0, ctx.limit) : unique;
    return limited.map((url): DiscoveredResource => {
      const file = url.replace(/^.*\//, '');
      const code = file.replace(/_THRU\.I11$/i, '');
      return { id: file, url, noradId: null, ext: 'i11', hints: { satelliteName: `SES ${code}` } };
    });
  },
};
