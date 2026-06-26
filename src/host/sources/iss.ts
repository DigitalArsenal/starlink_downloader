/**
 * ISS — NASA/JSC/FOD/TOPO public CCSDS OEM ephemeris (no auth).
 * Upstream: https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/
 */
import type { DiscoveredResource } from '../types.js';
import type { EphemerisSource } from './index.js';

const URL_OEM =
  'https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt';

export const issSource: EphemerisSource = {
  id: 'iss',
  name: 'International Space Station',
  operator: 'NASA',
  parserTag: 'ccsds-oem',
  contentExt: 'txt',
  host: 'nasa-public-data.s3.amazonaws.com',

  async discover(): Promise<DiscoveredResource[]> {
    return [
      {
        id: 'ISS.OEM_J2K_EPH.txt',
        url: URL_OEM,
        noradId: 25544,
        ext: 'oem',
        hints: { satelliteName: 'ISS (ZARYA)' },
      },
    ];
  },
};
