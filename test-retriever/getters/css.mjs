/**
 * China Space Station / Tiangong (CSS) — China Manned Space Agency public
 * CCSDS OEM ephemeris (BACC), published as a weekly zip on cmse.gov.cn.
 * The index page embeds the latest `./YYYYMM/W…….zip` link (Mon/Wed/Fri cadence).
 */

const BASE = 'https://www.cmse.gov.cn/gfgg/zgkjzgdcs/';

export const cssSource= {
  id: 'css-tiangong',
  name: 'China Space Station (Tiangong)',
  operator: 'China Manned Space Agency (BACC)',
  parserTag: 'css-oem-zip',
  contentExt: 'zip',
  host: 'www.cmse.gov.cn',

  async discover(ctx) {
    const html = await ctx.http.getText(BASE);
    const m = html.match(/\.\/(\d{6}\/W\d+\.zip)/);
    if (!m) return [];
    const rel = m[1] ;
    return [
      {
        id: rel.replace(/^.*\//, ''),
        url: `${BASE}${rel}`,
        noradId: 48274,
        ext: 'zip',
        hints: { satelliteName: 'Tiangong / CSS' },
      },
    ];
  },
};
