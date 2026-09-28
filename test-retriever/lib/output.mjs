import { mkdir, realpath, lstat, open, unlink, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const OUTPUTS = ['omm.fsb', 'ocm.fsb', 'obd.fsb', 'supgp-omm.fsb', 'comparison.jsonl', 'summary.md'];
export function isDeclaredOutput(name) {
  return OUTPUTS.includes(name) || ['celestrak-ledger.json', 'celestrak-ledger.json.tmp', '.retriever.lock'].includes(name)
    || /^supgp-[0-9a-f]{64}\.json$/.test(name);
}
export async function validateOutput(out) {
  const target = path.resolve(out);
  // Resolve the nearest existing parent BEFORE mkdir; reject lexical and symlink aliases into a repo.
  let existing = target; const suffix = [];
  for (;;) {
    try { existing = await realpath(existing); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; suffix.unshift(path.basename(existing)); existing = path.dirname(existing); }
  }
  const resolved = path.join(existing, ...suffix);
  const actualRepo = await realpath(repoRoot);
  if (resolved === actualRepo || resolved.startsWith(actualRepo + path.sep)) throw new Error('Output must be outside the repository');
  for (let dir = existing; ; dir = path.dirname(dir)) {
    try { await lstat(path.join(dir, '.git')); throw new Error('Output must be outside all Git worktrees'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(dir) === dir) break;
  }
  return resolved;
}
export class Output {
  static async create(out) {
    const dir = await validateOutput(out); await mkdir(dir, { recursive: true });
    const lock = await open(path.join(dir, '.retriever.lock'), 'wx', 0o600);
    const result = new Output(dir, lock);
    try {
      for (const file of OUTPUTS) {
        const target = path.join(dir, file);
        try { if ((await lstat(target)).isSymbolicLink()) throw new Error(`Output symlink refused: ${file}`); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await writeFile(target, '');
      }
      // Cache/ledger paths must not redirect writes outside the declared output directory.
      const { readdir } = await import('node:fs/promises');
      for (const file of await readdir(dir)) if (isDeclaredOutput(file) && (await lstat(path.join(dir, file))).isSymbolicLink()) throw new Error(`Output symlink refused: ${file}`);
      return result;
    } catch (error) { await result.close(); throw error; }
  }
  constructor(dir, lock) { this.dir = dir; this.lock = lock; }
  async append(name, bytes) {
    if (!OUTPUTS.includes(name) || name === 'summary.md') throw new Error('Undeclared output');
    await appendFile(path.join(this.dir, name), bytes);
  }
  async products(products) { for (const type of ['omm', 'ocm', 'obd']) await this.append(`${type}.fsb`, products[type]); }
  async summary(text) { await writeFile(path.join(this.dir, 'summary.md'), text); }
  async close() { if (!this.lock) return; await this.lock.close(); this.lock = null; await unlink(path.join(this.dir, '.retriever.lock')); }
}
export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); const n = sorted.length;
  return n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null;
}
export function summarize(report) {
  const value = n => n === null ? '—' : n.toFixed(3);
  const lines = ['# Operator ephemeris retrieval', '', `Started: ${report.startedAt}`, `Duration: ${(report.durationMs / 1000).toFixed(1)} s`, '',
    '| Source | Files fetched | Objects fetched | Fitted | Compared | Median ours km | Median SupGP km |',
    '|---|---:|---:|---:|---:|---:|---:|'];
  for (const s of report.sources) lines.push(`| ${s.id} | ${s.filesFetched} | ${s.unknownObjects ? 'unknown' : s.fetched} | ${s.fitted} | ${s.compared} | ${value(median(s.ourRms))} | ${value(median(s.supgpRms))} |`);
  lines.push('', 'Ours median includes all fitted objects; paired comparison medians are below. Unknown counts mean a fleet file was fetched but no applicable WASM parser identified its objects.', '',
    '## Comparison policy and limitations', '',
    'AGREE means absolute RMS difference ≤ 1 km on the same WASM fit samples. This is a provisional engineering threshold, not orbital accuracy certification. The existing fixture measures about 0.101 km; 1 km is about ten times that baseline and 1,000 times the text port’s 0.001 km rounding. Small live samples cannot establish a universal threshold.',
    'Only matching NORAD IDs and epochs within 11,520 seconds are compared. Max errors and element deltas are unavailable in these artifacts; comparison records contain explicit nulls. The supplemental node has no reference-scoring port. No JavaScript physics fills these gaps.',
    'OBD stores individual fit diagnostics. SDS OBD has no paired-model verdict/provenance fields, so comparison.jsonl is an explicitly interim JSON exception. OMM, OCM and OBD streams are size-prefixed SDS FlatBuffers.', '', '## Source details', '');
  for (const s of report.sources) {
    lines.push(`- ${s.id}: ${s.durationMs} ms; paired medians ${value(median(s.pairedOurRms))} / ${value(median(s.supgpRms))} km; disagreements ${s.disagreements}.`);
    for (const note of [...new Set(s.notes)]) lines.push(`  - ${note.replace(/[\r\n]/g, ' ')}`);
    for (const d of s.disagreementDetails) lines.push(`  - DISAGREE NORAD ${d.noradCatId}: ours ${d.ourRmsKm} km; SupGP ${d.supgpRmsKm} km; worse ${d.worse}.`);
  }
  lines.push('', '## Loaded artifacts (SHA-256 of full artifact before SDK loading)', '');
  for (const artifact of report.artifacts) lines.push(`- ${artifact.pluginId}: \`${artifact.sha256}\` — ${artifact.path}`);
  return lines.join('\n') + '\n';
}
