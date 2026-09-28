/**
 * Eutelsat OneWeb — operator-published "LTEF" (Long-Term Ephemeris File).
 *
 * Upstream feed (S3/CloudFront), no auth:
 *   https://ephemeris.oneweb.net/ltef/ltef.csv          (whole constellation)
 *   https://ephemeris.oneweb.net/timestamp.txt          (current epoch)
 *   https://ephemeris.oneweb.net/ltef_checksum/...       (SHA-1)
 */

const BASE = 'https://ephemeris.oneweb.net';

export const onewebSource= {
  id: 'eutelsat-oneweb',
  name: 'Eutelsat OneWeb',
  operator: 'Eutelsat OneWeb',
  parserTag: 'oneweb-ltef',
  contentExt: 'csv',
  host: 'ephemeris.oneweb.net',

  async discover() {
    return [
      {
        id: 'ltef.csv',
        url: `${BASE}/ltef/ltef.csv`,
        noradId: null,
        ext: 'csv',
        hints: { satelliteName: 'OneWeb constellation' },
      },
    ];
  },
};
