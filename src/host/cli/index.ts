#!/usr/bin/env node
/** `ephem` command-line interface. */
import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { EphemerisArchive } from '../api.js';
import { loadConfig, type Config } from '../config.js';
import { ProgressUI } from './progress.js';
import { join } from 'node:path';
import { ModuleRegistry } from '../modules/registry.js';
import { listSources } from '../sources/index.js';
import { PACKAGE_ROOT } from '../paths.js';
import { isTty } from '../logger.js';

const program = new Command();
program
  .name('ephem')
  .description('Fetch, normalize, validate, archive, and serve public satellite ephemerides')
  .option('-c, --config <path>', 'path to YAML config');

interface GlobalOpts {
  config?: string;
}

function applyLimit(config: Config, limit: number | undefined, sourceId?: string): Config {
  if (limit === undefined) return config;
  const sources = { ...config.sources };
  const ids = sourceId ? [sourceId] : listSources().map((s) => s.id);
  for (const id of ids) {
    sources[id] = { ...(sources[id] ?? loadConfig().sources[id] ?? defaultsFor()), limit };
  }
  return { ...config, sources };
}

function defaultsFor(): Config['sources'][string] {
  // zod defaults via loadConfig of empty source map; construct minimal default
  return {
    enabled: true,
    limit: null,
    timeoutMs: 60_000,
    retryCount: 5,
    rateLimitPerSec: 0,
    pollIntervalSec: 0,
  };
}

program
  .command('refresh')
  .description('Discover, download, parse, validate, and archive ephemerides')
  .option('-s, --source <id>', 'only refresh a single source')
  .option('-l, --limit <n>', 'cap resources discovered per source', (v) => parseInt(v, 10))
  .option('--no-progress', 'disable the live progress UI (structured logs only)')
  .action(async (opts: { source?: string; limit?: number; progress?: boolean }) => {
    const g = program.opts<GlobalOpts>();
    let config = loadConfig(g.config);
    config = applyLimit(config, opts.limit, opts.source);
    const archive = await EphemerisArchive.open({ config });
    const useBars = isTty && opts.progress !== false;
    const ui = new ProgressUI(archive.pipeline.events, useBars);
    ui.attach();
    try {
      const result = opts.source
        ? await archive.refreshSource(opts.source)
        : await archive.refresh();
      ui.stop();
      const totals = result.sources.reduce(
        (a, s) => ({
          discovered: a.discovered + s.discovered,
          stored: a.stored + s.stored,
          skipped: a.skipped + s.skipped,
          failed: a.failed + s.failed,
        }),
        { discovered: 0, stored: 0, skipped: 0, failed: 0 },
      );
      process.stdout.write(
        `\nDone. discovered=${totals.discovered} stored=${totals.stored} skipped=${totals.skipped} failed=${totals.failed}\n`,
      );
    } finally {
      ui.stop();
      await archive.close();
    }
  });

program
  .command('list-sources')
  .description('List configured sources and what is archived')
  .action(async () => {
    const g = program.opts<GlobalOpts>();
    const archive = await EphemerisArchive.open({ config: loadConfig(g.config), build: false });
    try {
      const defs = archive.listSourceDefinitions();
      const stored = new Map((await archive.listSources()).map((s) => [s.source, s]));
      const raw = new Map((await archive.storage.listRaw()).map((r) => [r.source, r]));
      for (const d of defs) {
        const s = stored.get(d.id);
        const r = raw.get(d.id);
        const archived = s
          ? `${s.satellites} sats / ${s.versions} versions`
          : r
            ? `${r.files} raw files (${(r.bytes / 1048576).toFixed(1)} MB)`
            : 'none';
        process.stdout.write(
          `${d.id.padEnd(18)} ${d.name.padEnd(34)} ${d.operator.padEnd(26)} ${archived}\n`,
        );
      }
    } finally {
      await archive.close();
    }
  });

program
  .command('list-satellites')
  .description('List archived satellites')
  .option('-s, --source <id>', 'filter by source')
  .action(async (opts: { source?: string }) => {
    const g = program.opts<GlobalOpts>();
    const archive = await EphemerisArchive.open({ config: loadConfig(g.config), build: false });
    try {
      const sats = await archive.listSatellites(opts.source);
      for (const s of sats) {
        process.stdout.write(
          `${String(s.noradId ?? '-').padEnd(8)} ${s.satelliteName.padEnd(24)} ${s.source.padEnd(18)} v${s.versions}\n`,
        );
      }
      process.stdout.write(`\n${sats.length} satellites\n`);
    } finally {
      await archive.close();
    }
  });

program
  .command('latest')
  .description('Show the latest archived record for a satellite')
  .requiredOption('--satellite <noradId>', 'NORAD id', (v) => parseInt(v, 10))
  .option('-s, --source <id>', 'source')
  .action(async (opts: { satellite: number; source?: string }) => {
    const g = program.opts<GlobalOpts>();
    const archive = await EphemerisArchive.open({ config: loadConfig(g.config), build: false });
    try {
      const rec = await archive.getLatest(opts.satellite, opts.source);
      process.stdout.write(rec ? `${JSON.stringify(rec, null, 2)}\n` : 'not found\n');
    } finally {
      await archive.close();
    }
  });

program
  .command('state')
  .description('Interpolate a state vector at an epoch')
  .requiredOption('--satellite <noradId>', 'NORAD id', (v) => parseInt(v, 10))
  .requiredOption('--epoch <iso>', 'ISO-8601 epoch (UTC)')
  .option('--interpolator <name>', 'lagrange | hermite')
  .option('--order <n>', 'interpolation order', (v) => parseInt(v, 10))
  .option('-s, --source <id>', 'source')
  .action(async (opts: { satellite: number; epoch: string; interpolator?: string; order?: number; source?: string }) => {
    const g = program.opts<GlobalOpts>();
    const archive = await EphemerisArchive.open({ config: loadConfig(g.config) });
    try {
      const state = await archive.getState(opts.satellite, opts.epoch, {
        ...(opts.interpolator ? { interpolator: opts.interpolator } : {}),
        ...(opts.order ? { order: opts.order } : {}),
        ...(opts.source ? { source: opts.source } : {}),
      });
      process.stdout.write(state ? `${JSON.stringify(state, null, 2)}\n` : 'not found\n');
    } finally {
      await archive.close();
    }
  });

program
  .command('validate')
  .description('Re-run validation over a satellite\'s latest archived ephemeris')
  .requiredOption('--satellite <noradId>', 'NORAD id', (v) => parseInt(v, 10))
  .option('-s, --source <id>', 'source')
  .action(async (opts: { satellite: number; source?: string }) => {
    const g = program.opts<GlobalOpts>();
    const archive = await EphemerisArchive.open({ config: loadConfig(g.config) });
    try {
      const ephem = await archive.getEphemeris(opts.satellite, opts.source);
      if (!ephem) {
        process.stdout.write('not found\n');
        return;
      }
      const { encodeStatesFrame, PORT, decodeJsonFrame } = await import('../wire.js');
      const { groupByPort } = await import('../modules/runner.js');
      const validator = archive.registry.byKind('validator')[0]!;
      const frames = await validator.module.invoke(validator.descriptor.methodId, [
        { portId: PORT.STATES, payload: encodeStatesFrame(ephem.states) },
      ]);
      const result = decodeJsonFrame(groupByPort(frames).get('result')![0]!);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      await archive.close();
    }
  });

program
  .command('export')
  .description('Export a satellite\'s latest ephemeris')
  .requiredOption('--satellite <noradId>', 'NORAD id', (v) => parseInt(v, 10))
  .requiredOption('--format <fmt>', 'json | csv | oem')
  .option('-s, --source <id>', 'source')
  .option('-o, --out <path>', 'write to a file instead of stdout')
  .action(async (opts: { satellite: number; format: string; source?: string; out?: string }) => {
    const g = program.opts<GlobalOpts>();
    if (!['json', 'csv', 'oem'].includes(opts.format)) {
      throw new Error(`unknown format '${opts.format}' (json|csv|oem)`);
    }
    const archive = await EphemerisArchive.open({ config: loadConfig(g.config) });
    try {
      const bytes = await archive.export(opts.satellite, opts.format as 'json' | 'csv' | 'oem', opts.source);
      if (opts.out) {
        writeFileSync(opts.out, bytes);
        process.stdout.write(`wrote ${bytes.byteLength} bytes to ${opts.out}\n`);
      } else {
        process.stdout.write(new TextDecoder().decode(bytes));
      }
    } finally {
      await archive.close();
    }
  });

program
  .command('list-plugins')
  .description('List registered compute modules (fetchers/parsers/validators/interpolators/exporters)')
  .action(async () => {
    const registry = ModuleRegistry.discover();
    await registry.loadExternal(join(PACKAGE_ROOT, '.external-cache'));
    for (const s of registry.status()) {
      process.stdout.write(
        `${s.kind.padEnd(13)} ${s.id.padEnd(24)} built=${s.built ? 'yes' : 'no '} provides=[${s.provides.join(', ')}]\n`,
      );
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
