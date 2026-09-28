/**
 * GPS & GLONASS precise ephemerides (SP3) from upstream IGS analysis centers.
 *
 *  - GPS:     BKG  https://igs.bkg.bund.de/root_ftp/IGS/products/<gpsweek>/
 *             newest IGS0OPSULT_* (ultra-rapid) → IGS0OPSRAP_* (rapid)  [GPS only]
 *  - GLONASS: ESA  http://navigation-office.esa.int/products/gnss-products/<gpsweek>/
 *             newest ESA0OPSULT_* → ESA0OPSRAP_*  [GPS + GLONASS together]
 *
 * The IGS long filename embeds a sortable timestamp, so the newest file is the
 * lexicographic maximum of the matching names in the current (or previous) week.
 */
                                                      
                                                                 
import { gpsWeek, newestMatching } from './util.mjs';

const SUFFIX = '_ORB.SP3.gz';

async function discoverSp3(
  ctx               ,
  base        ,
  prefixes          ,
  satelliteName        ,
)                                {
  const weeks = [gpsWeek(), gpsWeek() - 1];
  for (const week of weeks) {
    let html        ;
    try {
      html = await ctx.http.getText(`${base}/${week}/`);
    } catch {
      continue;
    }
    for (const prefix of prefixes) {
      const name = newestMatching(html, prefix, SUFFIX);
      if (name) {
        return [
          {
            id: name,
            url: `${base}/${week}/${name}`,
            noradId: null,
            ext: 'sp3.gz',
            hints: { satelliteName },
          },
        ];
      }
    }
  }
  return [];
}

export const gpsSource                  = {
  id: 'gps-precise',
  name: 'GPS precise ephemerides (SP3)',
  operator: 'IGS / BKG',
  parserTag: 'sp3',
  contentExt: 'sp3.gz',
  host: 'igs.bkg.bund.de',
  discover: (ctx) =>
    discoverSp3(
      ctx,
      'https://igs.bkg.bund.de/root_ftp/IGS/products',
      ['IGS0OPSULT', 'IGS0OPSRAP'],
      'GPS constellation',
    ),
};

export const glonassSource                  = {
  id: 'glonass-precise',
  name: 'GLONASS precise ephemerides (SP3)',
  operator: 'IGS / ESA',
  parserTag: 'sp3',
  contentExt: 'sp3.gz',
  host: 'navigation-office.esa.int',
  discover: (ctx) =>
    discoverSp3(
      ctx,
      'http://navigation-office.esa.int/products/gnss-products',
      ['ESA0OPSULT', 'ESA0OPSRAP'],
      'GLONASS (+GPS) constellation',
    ),
};
