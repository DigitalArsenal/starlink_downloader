/**
 * SpaceX Starlink public ephemerides.
 *
 * Discovery fetches the public MANIFEST.txt (one filename per line) and derives
 * the per-satellite identity from the filename, e.g.
 *   MEME_62559_STARLINK-11517_1762216_Operational_1466720220_UNCLASSIFIED.txt
 *        ^norad ^name          ^intl   ^status    ^gen-unix   ^classification
 */
import type { DiscoveredResource } from '../types.js';
import type { EphemerisSource, SourceContext } from './index.js';

const BASE = 'https://api.starlink.com/public-files/ephemerides/';
const MANIFEST = `${BASE}MANIFEST.txt`;

function parseFilename(name: string): { noradId: number | null; hints: Record<string, string> } {
  const stem = name.replace(/\.txt$/i, '');
  const parts = stem.split('_');
  // [MEME, norad, name, intlId, status, genUnix, classification]
  const noradRaw = parts[1] ?? '';
  const noradId = /^\d+$/.test(noradRaw) ? Number(noradRaw) : null;
  return {
    noradId,
    hints: {
      satelliteName: parts[2] ?? stem,
      internalId: parts[3] ?? '',
      opsStatus: parts[4] ?? '',
      generatedUnix: parts[5] ?? '',
      classification: parts[6] ?? '',
    },
  };
}

export const starlinkSource: EphemerisSource = {
  id: 'spacex-starlink',
  name: 'SpaceX Starlink',
  operator: 'SpaceX',
  parserTag: 'spacex-starlink',
  contentExt: 'txt',
  host: 'api.starlink.com',

  async discover(ctx: SourceContext): Promise<DiscoveredResource[]> {
    const manifest = await ctx.http.getText(MANIFEST);
    const lines = manifest
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.toLowerCase().endsWith('.txt'));
    const limited = ctx.limit ? lines.slice(0, ctx.limit) : lines;
    return limited.map((name): DiscoveredResource => {
      const { noradId, hints } = parseFilename(name);
      return { id: name, url: `${BASE}${name}`, noradId, hints };
    });
  },
};
