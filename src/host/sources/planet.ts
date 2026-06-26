/**
 * Planet Labs — operator-published public orbital ephemerides.
 * Upstream: https://ephemerides.planet-labs.com/ (no auth).
 *   planet.states  — per-satellite state vectors (id, time, x,y,z, vx,vy,vz, …)
 *   planet_mc.tle  — TLEs
 */
import type { DiscoveredResource } from '../types.js';
import type { EphemerisSource } from './index.js';

const BASE = 'https://ephemerides.planet-labs.com';

export const planetSource: EphemerisSource = {
  id: 'planet',
  name: 'Planet Labs',
  operator: 'Planet Labs PBC',
  parserTag: 'planet-states',
  contentExt: 'states',
  host: 'ephemerides.planet-labs.com',

  async discover(): Promise<DiscoveredResource[]> {
    return [
      {
        id: 'planet.states',
        url: `${BASE}/planet.states`,
        noradId: null,
        ext: 'states',
        hints: { satelliteName: 'Planet fleet (states)' },
      },
      {
        id: 'planet_mc.tle',
        url: `${BASE}/planet_mc.tle`,
        noradId: null,
        ext: 'tle',
        hints: { satelliteName: 'Planet fleet (TLE)' },
      },
    ];
  },
};
