import { sources, anonymous, getSource } from '../getters/index.mjs';
import { Processor } from './process.mjs';
import { Celestrak, groups } from './celestrak.mjs';
import { compare } from './compare.mjs';
import { Output, summarize } from './output.mjs';
export async function run({ sourceIds = anonymous.map(s => s.id), limit = 50, out,
  supgp = true, fetchImpl = fetch, onProgress = () => {} }) {
  const selected = sourceIds.map(id => { const source = sources.find(s => s.id === id); if (!source) throw new Error(`Unknown source: ${id}`); return source; });
  const output = await Output.create(out);
  const processor = new Processor();
  const celestrak = new Celestrak(output.dir, { fetchImpl });
  const start = Date.now();
  const report = { startedAt: new Date(start).toISOString(), durationMs: 0, artifacts: [], sources: [] };
  try {
    for (const source of selected) {
      const sourceStart = Date.now();
      const stats = { id: source.id, filesFetched: 0, fetched: 0, unknownObjects: false, fitted: 0, compared: 0,
        ourRms: [], pairedOurRms: [], supgpRms: [], disagreements: 0, disagreementDetails: [], notes: [], durationMs: 0 };
      report.sources.push(stats); onProgress(`Starting ${source.id}`);
      let references = supgp ? [] : null;
      if (supgp) for (const group of groups[source.id] ?? []) {
        try { references.push(...(await celestrak.get(group)).rows); }
        catch (error) { if (celestrak.failures >= 30) throw error; stats.notes.push(`${group} SupGP: ${error.message}`); }
      }
      let queue = Promise.resolve();
      try { await getSource(source, { limit, fetchImpl, note: note => stats.notes.push(note), consume: item => {
        const work = queue.then(async () => {
          stats.filesFetched++;
          const fleet = ['eutelsat-oneweb', 'planet', 'gps-precise', 'glonass-precise', 'esa-pod'].includes(source.id);
          if (fleet) stats.unknownObjects = true; else stats.fetched++;
          let fitted;
          try { fitted = await processor.fit(item, limit - stats.fitted); }
          catch (error) {
            stats.notes.push(error.message);
            await output.append('comparison.jsonl', JSON.stringify({ version: 1, source: source.id, provenance: item.provenance,
              verdict: 'NOT_FITTED', note: error.message }) + '\n');
            return;
          }
          if (fleet) { stats.fetched += fitted.length; stats.unknownObjects = false; }
          for (const fit of fitted) {
            await output.products(fit.products); stats.fitted++; stats.ourRms.push(Number(fit.fit.RMS));
            let comparison;
            try { comparison = await compare(processor, item, fit, references); }
            catch (error) {
              stats.notes.push(error.message); comparison = await compare(processor, item, fit, null);
              comparison.record.note = error.message;
            }
            await output.append('comparison.jsonl', JSON.stringify(comparison.record) + '\n');
            if (comparison.supgp) {
              await output.append('supgp-omm.fsb', comparison.supgp);
              stats.compared++; stats.supgpRms.push(comparison.record.supgpRmsKm); stats.pairedOurRms.push(comparison.record.ourRmsKm);
            } else if (comparison.record.note) stats.notes.push(comparison.record.note);
            if (comparison.record.verdict === 'DISAGREE') {
              stats.disagreements++; stats.disagreementDetails.push(comparison.record);
            }
          }
        });
        queue = work.catch(() => {}); return work;
      } }); } catch (error) { stats.notes.push(`Discovery failed: ${error.message}`); }
      await queue; stats.durationMs = Date.now() - sourceStart;
      onProgress(`${source.id}: ${stats.filesFetched} files, ${stats.fitted} fitted, ${stats.compared} compared`);
    }
  } finally {
    try {
      await processor.close(); report.artifacts = processor.artifacts; report.durationMs = Date.now() - start;
      await output.summary(summarize(report));
    } finally { await output.close(); }
  }
  return report;
}
