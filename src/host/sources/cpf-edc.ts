/**
 * CPF for the FULL ILRS target set, via EDC (EUROLAS Data Center, DGFI-TUM).
 *
 * Requires a free EDC account. Set `EDC_USERNAME` / `EDC_PASSWORD` in `.env`
 * (register at https://edc.dgfi.tum.de). Without them this source is inert.
 *
 * EDC exposes a POST form API:
 *   action=list-predictions-v2  -> the valid CPF predictions (ids + metadata)
 *   action=data-download&data_type=CPF&id=<id>  -> one CPF file
 * Discovery lists predictions, keeps the newest per target, and returns each as
 * a POST resource (the pipeline supports method/body). Covers LAGEOS, LARES,
 * Etalon, Sentinel, Jason, GLONASS, BeiDou, etc. — beyond ESA's Galileo-only
 * anonymous `cpf` source.
 *
 * The exact JSON shape of list-predictions is account-gated; parsing here is
 * defensive and emits a clear diagnostic (response snippet, never credentials)
 * if it cannot extract records, so it can be tuned against a live account.
 */
import type { DiscoveredResource } from '../types.js';
import type { EphemerisSource, SourceContext } from './index.js';
import { edcCredentials, type EdcCredentials } from '../env.js';
import { childLogger } from '../logger.js';

const log = childLogger({ component: 'source:cpf-edc' });

interface PredictionRecord {
  id: string;
  label: string;
  recency: string;
}

function form(creds: EdcCredentials, params: Record<string, string>): string {
  const all: Record<string, string> = {
    username: creds.username,
    password: creds.password,
    ...params,
  };
  return Object.entries(all)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function pick(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).length > 0) return String(v);
  }
  return null;
}

/** Normalize EDC's list response into {id,label,recency} defensively. */
function parsePredictions(text: string): PredictionRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  let rows: unknown[];
  if (Array.isArray(parsed)) rows = parsed;
  else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown }).data)) {
    rows = (parsed as { data: unknown[] }).data;
  } else if (parsed && typeof parsed === 'object') rows = Object.values(parsed as object);
  else return [];

  const out: PredictionRecord[] = [];
  for (const row of rows) {
    if (Array.isArray(row)) {
      const id = row.find((v) => /^\d+$/.test(String(v)));
      const label = row.find((v) => typeof v === 'string' && /[a-z]/i.test(String(v)));
      if (id !== undefined) {
        out.push({ id: String(id), label: String(label ?? id), recency: String(id) });
      }
    } else if (row && typeof row === 'object') {
      const o = row as Record<string, unknown>;
      const id = pick(o, ['id', 'prediction_id', 'dataset_id', 'data_id']);
      if (!id) continue;
      const label =
        pick(o, ['satellite_name', 'satellite', 'target', 'satellite_id', 'filename']) ?? id;
      const recency =
        pick(o, ['start', 'start_date', 'start_epoch', 'epoch', 'date', 'created', 'datetime']) ?? id;
      out.push({ id, label, recency });
    }
  }
  return out;
}

export const cpfEdcSource: EphemerisSource = {
  id: 'cpf-edc',
  name: 'CPF full ILRS set (EDC, login)',
  operator: 'EDC / DGFI-TUM (ILRS)',
  parserTag: 'cpf',
  contentExt: 'cpf',
  host: 'edc.dgfi.tum.de',

  async discover(ctx: SourceContext): Promise<DiscoveredResource[]> {
    const creds = edcCredentials();
    if (!creds) {
      log.warn('EDC_USERNAME/PASSWORD not set — skipping EDC CPF (free account at edc.dgfi.tum.de)');
      return [];
    }

    const provider = process.env.EDC_PROVIDER?.trim();
    const res = await ctx.http.post(
      creds.apiUrl,
      form(creds, { action: 'list-predictions-v2', ...(provider ? { provider } : {}) }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    const text = new TextDecoder().decode(res.bytes);
    if (/access denied/i.test(text)) throw new Error('EDC: access denied (check EDC_USERNAME/PASSWORD)');

    let records = parsePredictions(text);
    if (records.length === 0) {
      throw new Error(
        `EDC: could not parse list-predictions response (shape unexpected). First 200 chars: ${text.slice(0, 200)}`,
      );
    }

    // Optional satellite filter; keep newest per target.
    const filter = (process.env.EDC_SATELLITES?.trim() || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (filter.length) {
      records = records.filter((r) => filter.some((f) => r.label.toLowerCase().includes(f)));
    }
    const newestByTarget = new Map<string, PredictionRecord>();
    for (const r of records) {
      const prev = newestByTarget.get(r.label);
      if (!prev || r.recency > prev.recency) newestByTarget.set(r.label, r);
    }

    const targets = [...newestByTarget.values()].sort((a, b) => a.label.localeCompare(b.label));
    const max = ctx.limit ?? Number(process.env.EDC_MAX ?? 200);
    return targets.slice(0, max).map((r): DiscoveredResource => ({
      id: `cpf_${r.label}_${r.id}.cpf`,
      url: creds.apiUrl,
      method: 'POST',
      body: form(creds, { action: 'data-download', data_type: 'CPF', id: r.id }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      noradId: null,
      ext: 'cpf',
      hints: { satelliteName: `CPF ${r.label}` },
    }));
  },
};
