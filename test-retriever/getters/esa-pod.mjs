/**
 * ESA Precise Orbit Determination (POD) products — ESA/ESOC Navigation Office.
 * Upstream (open HTTP, no auth): http://navigation-office.esa.int/products/
 *
 * Fetches the newest of ESA's flagship POD orbit products (all SP3):
 *   - multi-GNSS POD   gnss-products/<gpsweek>/ESA0MGNFIN_*_ORB.SP3.gz
 *                      (GPS + GLONASS + Galileo + BeiDou + QZSS; falls back to
 *                       ESA0OPSRAP/ESA0OPSULT for lower latency)
 *   - Swarm A/B/C POD  swarm/SWRAesoc<gpsweek><dow>.sp3.gz
 *   - CryoSat-2 POD    cryosat2/<YYMMDD>.cs2.v4.sp3.gz
 */

import { gpsWeek, newestMatching } from './util.mjs';

const BASE = 'http://navigation-office.esa.int/products';

async function newestInDir(
  http,
  dirUrl,
  prefixes,
  suffix,
) {
  let html        ;
  try {
    html = await http.getText(dirUrl);
  } catch {
    return null;
  }
  for (const prefix of prefixes) {
    const name = newestMatching(html, prefix, suffix);
    if (name) return name;
  }
  return null;
}

export const esaPodSource= {
  id: 'esa-pod',
  name: 'ESA Precise Orbit Determination (POD)',
  operator: 'ESA / ESOC Navigation Office',
  parserTag: 'sp3',
  contentExt: 'sp3.gz',
  host: 'navigation-office.esa.int',

  async discover(ctx) {
    const out= [];

    // multi-GNSS POD — current GPS week, else previous.
    for (const week of [gpsWeek(), gpsWeek() - 1]) {
      const name = await newestInDir(
        ctx.http,
        `${BASE}/gnss-products/${week}/`,
        ['ESA0MGNFIN', 'ESA0OPSRAP', 'ESA0OPSULT'],
        '_ORB.SP3.gz',
      );
      if (name) {
        out.push({
          id: name,
          url: `${BASE}/gnss-products/${week}/${name}`,
          noradId: null,
          ext: 'sp3.gz',
          hints: { satelliteName: 'ESA multi-GNSS POD (G/R/E/C/J)' },
        });
        break;
      }
    }

    // Swarm A/B/C POD (flat daily dir).
    const swarm = await newestInDir(ctx.http, `${BASE}/swarm/`, ['SWRAesoc'], '.sp3.gz');
    if (swarm) {
      out.push({
        id: swarm,
        url: `${BASE}/swarm/${swarm}`,
        noradId: null,
        ext: 'sp3.gz',
        hints: { satelliteName: 'Swarm A/B/C POD' },
      });
    }

    // CryoSat-2 POD (flat daily dir; prefer v4 final, else v3).
    const cs2 =
      (await newestInDir(ctx.http, `${BASE}/cryosat2/`, [''], '.cs2.v4.sp3.gz')) ??
      (await newestInDir(ctx.http, `${BASE}/cryosat2/`, [''], '.cs2.v3.sp3.gz'));
    if (cs2) {
      out.push({
        id: cs2,
        url: `${BASE}/cryosat2/${cs2}`,
        noradId: 36508,
        ext: 'sp3.gz',
        hints: { satelliteName: 'CryoSat-2 POD' },
      });
    }

    return ctx.limit ? out.slice(0, ctx.limit) : out;
  },
};
