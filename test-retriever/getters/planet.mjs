/**
 * Planet Labs — operator-published public orbital ephemerides.
 * Upstream: https://ephemerides.planet-labs.com/ (no auth).
 *   planet.states  — per-satellite state vectors (id, time, x,y,z, vx,vy,vz, …)
 *   planet_mc.tle  — TLEs
 */

const BASE = 'https://ephemerides.planet-labs.com';

export const planetSource= {
  id: 'planet',
  name: 'Planet Labs',
  operator: 'Planet Labs PBC',
  parserTag: 'planet-states',
  contentExt: 'states',
  host: 'ephemerides.planet-labs.com',

  async discover() {
    return [
      {
        id: 'planet.states',
        url: `${BASE}/planet.states`,
        noradId: null,
        ext: 'states',
        hints: { satelliteName: 'Planet fleet (states)' },
      },
    ];
  },
};
