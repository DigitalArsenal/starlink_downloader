/**
 * Public API — the façade over the whole system.
 *
 * `EphemerisArchive` wires the module registry, the SQLite archive, the SDK
 * isomorphic http client, the source registry, and the ingestion pipeline.
 */
import { join } from 'node:path';
import type { Config } from './config.js';
import { loadConfig, sourceConfig } from './config.js';
import { PACKAGE_ROOT } from './paths.js';
import { ModuleRegistry } from './modules/registry.js';
import { FlatSqlStorage } from './storage/flatsql.js';
import type { StorageAdapter } from './storage/index.js';
import { HttpClient } from './http.js';
import { Pipeline } from './pipeline.js';
import { listSources, getSource, type EphemerisSource } from './sources/index.js';
import { interpolateStates } from './interpolate.js';
import { encodeStatesFrame, PORT } from './wire.js';
import { groupByPort } from './modules/runner.js';
import { isoToUnix, nowIso } from './util.js';
import { childLogger } from './logger.js';
import type {
  RefreshResult,
  SatelliteEphemeris,
  StateVector,
  StoredEphemerisRecord,
} from './types.js';

const log = childLogger({ component: 'archive' });

export interface GetStateOptions {
  interpolator?: string;
  order?: number;
  source?: string;
}

export interface OpenOptions {
  configPath?: string;
  config?: Config;
  /** Build (compile) modules on open if stale. Default true. */
  build?: boolean;
}

export class EphemerisArchive {
  private constructor(
    readonly config: Config,
    readonly registry: ModuleRegistry,
    readonly storage: StorageAdapter,
    readonly http: HttpClient,
    readonly pipeline: Pipeline,
  ) {}

  static async open(opts: OpenOptions = {}): Promise<EphemerisArchive> {
    const config = opts.config ?? loadConfig(opts.configPath);
    const registry = ModuleRegistry.discover();
    if (opts.build !== false) await registry.buildAll();
    await registry.loadExternal(join(PACKAGE_ROOT, '.external-cache'));

    const storage = new FlatSqlStorage(config.dataDir);
    await storage.init();

    const http = new HttpClient();
    for (const source of listSources()) {
      const cfg = sourceConfig(config, source.id);
      if (cfg.rateLimitPerSec > 0) http.setRateLimit(source.host, 1000 / cfg.rateLimitPerSec);
    }

    const pipeline = new Pipeline(registry, storage, http, config);
    log.debug('archive opened');
    return new EphemerisArchive(config, registry, storage, http, pipeline);
  }

  /** Enabled sources (per config). */
  enabledSources(): EphemerisSource[] {
    return listSources().filter((s) => sourceConfig(this.config, s.id).enabled);
  }

  // --- Public surface -------------------------------------------------------

  async refresh(): Promise<RefreshResult> {
    const startedAt = nowIso();
    const sources = [];
    for (const source of this.enabledSources()) {
      sources.push(await this.pipeline.refreshSource(source));
    }
    return { startedAt, finishedAt: nowIso(), sources };
  }

  async refreshSource(id: string): Promise<RefreshResult> {
    const source = getSource(id);
    if (!source) throw new Error(`unknown source '${id}'`);
    const startedAt = nowIso();
    const result = await this.pipeline.refreshSource(source);
    return { startedAt, finishedAt: nowIso(), sources: [result] };
  }

  listSourceDefinitions(): EphemerisSource[] {
    return listSources();
  }

  async listSources(): Promise<Array<{ source: string; satellites: number; versions: number }>> {
    return this.storage.listSources();
  }

  async listSatellites(
    source?: string,
  ): Promise<Array<{ noradId: number | null; satelliteName: string; source: string; versions: number }>> {
    return this.storage.listSatellites(source);
  }

  async getVersions(noradId: number, source?: string): Promise<StoredEphemerisRecord[]> {
    return this.storage.getVersions(noradId, source);
  }

  async getLatest(noradId: number, source?: string): Promise<StoredEphemerisRecord | null> {
    return this.storage.latest(noradId, source);
  }

  /** Load the full normalized ephemeris (latest version) for a satellite. */
  async getEphemeris(noradId: number, source?: string): Promise<SatelliteEphemeris | null> {
    const latest = await this.storage.latest(noradId, source);
    if (!latest) return null;
    return this.storage.load(latest.id);
  }

  /** Interpolate a single state vector at an epoch (ISO) for a satellite. */
  async getState(
    noradId: number,
    epochIso: string,
    opts: GetStateOptions = {},
  ): Promise<StateVector | null> {
    const ephem = await this.getEphemeris(noradId, opts.source);
    if (!ephem || ephem.states.length === 0) return null;
    const interpolator = opts.interpolator ?? this.config.interpolation.defaultInterpolator;
    const order = opts.order ?? this.config.interpolation.defaultOrder;
    const epoch = isoToUnix(epochIso);
    const statesFrame = encodeStatesFrame(ephem.states);
    const [state] = await interpolateStates(this.registry, interpolator, statesFrame, [epoch], order);
    return state ?? null;
  }

  /** Export a satellite's latest ephemeris in the requested format. */
  async export(noradId: number, format: 'json' | 'csv' | 'oem', source?: string): Promise<Uint8Array> {
    const ephem = await this.getEphemeris(noradId, source);
    if (!ephem) throw new Error(`no archived ephemeris for NORAD ${noradId}`);
    if (format === 'json') {
      return new TextEncoder().encode(JSON.stringify(ephem, null, 2));
    }
    if (format === 'csv') {
      const exporter = this.registry.provider('exporter', 'csv');
      if (!exporter) throw new Error("no exporter module provides 'csv'");
      const frames = await exporter.module.invoke(exporter.descriptor.methodId, [
        { portId: PORT.STATES, payload: encodeStatesFrame(ephem.states) },
      ]);
      const out = groupByPort(frames).get(PORT.OUT)?.[0];
      if (!out) throw new Error('csv exporter produced no output');
      return out;
    }
    // CCSDS OEM (KVN text) — a standard, Tudat-readable representation.
    return new TextEncoder().encode(toOemKvn(ephem));
  }

  async close(): Promise<void> {
    await this.registry.destroy();
    await this.storage.close();
  }
}

/** Render a normalized ephemeris as a CCSDS OEM (KVN) text message. */
function toOemKvn(e: SatelliteEphemeris): string {
  const lines: string[] = [];
  lines.push('CCSDS_OEM_VERS = 2.0');
  lines.push(`CREATION_DATE = ${e.creationDate ?? nowIso()}`);
  lines.push(`ORIGINATOR = ${e.operator}`);
  lines.push('META_START');
  lines.push(`OBJECT_NAME = ${e.satelliteName}`);
  lines.push(`OBJECT_ID = ${e.cosparId ?? e.noradId ?? 'UNKNOWN'}`);
  lines.push('CENTER_NAME = EARTH');
  lines.push(`REF_FRAME = ${e.referenceFrame}`);
  lines.push(`TIME_SYSTEM = ${e.timeSystem}`);
  lines.push(`START_TIME = ${e.validityStart}`);
  lines.push(`STOP_TIME = ${e.validityEnd}`);
  lines.push('META_STOP');
  for (const s of e.states) {
    const iso = new Date(s.epoch * 1000).toISOString();
    const km = (m: number): string => (m / 1000).toFixed(6);
    const kmps = (m: number): string => (m / 1000).toFixed(9);
    lines.push(
      `${iso} ${km(s.positionMeters[0])} ${km(s.positionMeters[1])} ${km(s.positionMeters[2])} ` +
        `${kmps(s.velocityMetersPerSecond[0])} ${kmps(s.velocityMetersPerSecond[1])} ${kmps(s.velocityMetersPerSecond[2])}`,
    );
  }
  return lines.join('\n') + '\n';
}

export { loadConfig } from './config.js';
export type { Config } from './config.js';
export * from './types.js';
