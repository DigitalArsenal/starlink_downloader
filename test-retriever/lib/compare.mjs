import { fitFailure } from './process.mjs';
import { ommBytes } from './products.mjs';
export const RMS_THRESHOLD_KM = 1;
export const MAX_EPOCH_DIFFERENCE_SEC = 11520;
const epochMs = iso => Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(iso) ? iso : `${iso}Z`);
const fields = { refMeanMotion: 'MEAN_MOTION', refEccentricity: 'ECCENTRICITY',
  refInclination: 'INCLINATION', refRaan: 'RA_OF_ASC_NODE', refArgPericenter: 'ARG_OF_PERICENTER',
  refMeanAnomaly: 'MEAN_ANOMALY', refBstar: 'BSTAR', refMeanMotionDot: 'MEAN_MOTION_DOT', refMeanMotionDdot: 'MEAN_MOTION_DDOT' };
export function closestReference(fit, rows) {
  if (!(Number(fit.NORAD_CAT_ID) > 0)) return null;
  const candidates = rows.filter(row => Number(row.NORAD_CAT_ID) === Number(fit.NORAD_CAT_ID))
    .map(row => ({ row, epochDifferenceSec: (epochMs(row.EPOCH) - epochMs(fit.EPOCH)) / 1000 }))
    .filter(entry => Number.isFinite(entry.epochDifferenceSec))
    .sort((a, b) => Math.abs(a.epochDifferenceSec) - Math.abs(b.epochDifferenceSec));
  return candidates[0] ?? null;
}
export function referenceOptions(row) {
  const options = { refEpoch: row.EPOCH };
  for (const [key, field] of Object.entries(fields)) {
    const value = Number(row[field] ?? (['BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'].includes(field) ? 0 : NaN));
    if (!Number.isFinite(value)) throw new Error(`SupGP missing finite ${field}`);
    options[key] = value;
  }
  if (options.refMeanMotion <= 0) throw new Error('SupGP mean motion must be positive');
  return options;
}
export async function compare(processor, item, fitted, references) {
  const record = { version: 1, source: item.source.id, noradCatId: fitted.fit.NORAD_CAT_ID,
    objectName: fitted.fit.OBJECT_NAME, epoch: fitted.fit.EPOCH, provenance: item.provenance,
    ourRmsKm: Number(fitted.fit.RMS), ourMaxErrorKm: null, supgpRmsKm: null, supgpMaxErrorKm: null,
    epochDifferenceSec: null, elementDeltas: null, thresholdKm: RMS_THRESHOLD_KM,
    verdict: 'NOT_COMPARED', worse: null,
    missingMetrics: ['OD artifacts do not emit maximum residuals or element deltas.'],
  };
  if (!references) { record.note = 'SupGP disabled or unavailable'; return { record }; }
  const match = closestReference(fitted.fit, references);
  if (!match) { record.note = 'No matching NORAD_CAT_ID in SupGP (unknown identities are not guessed)'; return { record }; }
  record.epochDifferenceSec = match.epochDifferenceSec;
  if (Math.abs(match.epochDifferenceSec) > MAX_EPOCH_DIFFERENCE_SEC) {
    record.note = 'Closest SupGP epoch lies beyond the 11520-second fit-window gate'; return { record };
  }
  if (!fitted.canScore) {
    record.note = 'Supplemental OD node exposes no reference-scoring input and does not emit parsed operator states'; return { record };
  }
  // No JS propagation, frames, residual calculation or orbital element deltas.
  // The module scores its fit and the reference against exactly the same fit samples.
  const scored = await processor.textFit(fitted.scoringBytes ?? item.bytes, { ...fitted.options, ...referenceOptions(match.row) });
  if (scored.REFERENCE_RMS === undefined || fitFailure(scored.REFERENCE_RMS)) throw new Error('OD artifact did not return a valid reference RMS (missing or propagation failed)');
  if (Number(scored.RMS) !== record.ourRmsKm) throw new Error('Reference scoring changed the fitted RMS');
  record.supgpRmsKm = Number(scored.REFERENCE_RMS);
  record.verdict = Math.abs(record.ourRmsKm - record.supgpRmsKm) <= RMS_THRESHOLD_KM ? 'AGREE' : 'DISAGREE';
  if (record.verdict === 'DISAGREE') record.worse = record.ourRmsKm > record.supgpRmsKm ? 'ours' : 'SupGP';
  return { record, supgp: ommBytes(match.row) };
}
