/**
 * CPF (Consolidated Prediction Format) — satellite laser-ranging predictions.
 * Upstream (anonymous): ESA/ESOC Navigation Office.
 *   http://navigation-office.esa.int/products/cpf_predictions/
 *   files: <target>_cpf_<yymmdd>_<seq>.esa  (CPF v2, ASCII, uncompressed)
 *
 * Covers the ESA-provided laser targets (Galileo). The full ILRS target set
 * (LAGEOS, LARES, Etalon, Sentinel, Jason, …) lives at EDC (edc.dgfi.tum.de)
 * or CDDIS, which require a free account — see docs/sources.md.
 */

const BASE = 'http://navigation-office.esa.int/products/cpf_predictions';

export const cpfSource= {
  id: 'cpf',
  name: 'CPF laser-ranging predictions (ESA)',
  operator: 'ESA / ESOC Navigation Office',
  parserTag: 'cpf',
  contentExt: 'cpf',
  host: 'navigation-office.esa.int',

  async discover(ctx) {
    const html = await ctx.http.getText(`${BASE}/`);
    // <target>_cpf_<yymmdd>_<seq>.esa — keep the newest per target.
    const best = new Map                                                       ();
    for (const m of html.matchAll(/([a-z0-9]+)_cpf_(\d{6})_(\d+)\.esa/gi)) {
      const [file, target, yymmdd, seqRaw] = [m[0] , m[1] , m[2] , m[3] ];
      const seq = Number(seqRaw);
      const prev = best.get(target);
      if (!prev || yymmdd > prev.yymmdd || (yymmdd === prev.yymmdd && seq > prev.seq)) {
        best.set(target, { file, yymmdd, seq });
      }
    }
    const targets = [...best.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const limited = ctx.limit ? targets.slice(0, ctx.limit) : targets;
    return limited.map(([target, { file }])                     => ({
      id: file,
      url: `${BASE}/${file}`,
      noradId: null,
      ext: 'cpf',
      hints: { satelliteName: `CPF ${target}` },
    }));
  },
};
