#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { run } from '../lib/run.mjs';
import { summarize } from '../lib/output.mjs';
export function parseArgs(argv) {
  const config = { sourceIds: [], limit: 50, supgp: true,
    out: `/opt/data/operator-od/runs/${new Date().toISOString().replace(/[:.]/g, '-')}` };
  let limitSeen = false; let allSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => { const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`); return value; };
    if (arg === '--source') config.sourceIds.push(take());
    else if (arg === '--out') config.out = take();
    else if (arg === '--limit') { limitSeen = true; config.limit = Number(take()); if (!Number.isSafeInteger(config.limit) || config.limit < 1) throw new Error('--limit must be a positive integer'); }
    else if (arg === '--all') { allSeen = true; config.limit = Infinity; }
    else if (arg === '--no-supgp') config.supgp = false;
    else if (arg === '--help' || arg === '-h') config.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (limitSeen && allSeen) throw new Error('--limit and --all are mutually exclusive');
  if (!config.sourceIds.length) delete config.sourceIds;
  else config.sourceIds = [...new Set(config.sourceIds)];
  return config;
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = parseArgs(process.argv.slice(2));
    if (config.help) console.log('node test-retriever/bin/retrieve.mjs [--source <id>...] [--limit N | --all] [--out dir] [--no-supgp]');
    else console.log(summarize(await run({ ...config, onProgress: text => console.error(text) })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
