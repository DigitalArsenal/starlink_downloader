/**
 * The ingestion pipeline — realizes the `EphemerisFetcher` contract by driving
 * the registry-resolved WASM compute modules for each stage:
 *
 *   discover -> fetch -> parse(module) -> validate(module) -> normalize -> store
 *
 * Network egress uses the SDK isomorphic http capability (with retry/backoff);
 * parsing and validation run entirely in WASM; storage is versioned and never
 * overwrites.
 */
import { z } from 'zod';
import type {
  DiscoveredResource,
  RawEphemerisFile,
  SatelliteEphemeris,
  SourceRefreshResult,
  StateVector,
  ValidationResult,
  ReferenceFrame,
  TimeSystem,
  InterpolationType,
} from './types.js';
import type { ModuleRegistry } from './modules/registry.js';
import type { StorageAdapter } from './storage/index.js';
import type { HttpClient } from './http.js';
import type { Config } from './config.js';
import type { EphemerisSource, SourceContext } from './sources/index.js';
import { sourceConfig } from './config.js';
import { decodeJsonFrame, decodeStatesFrame, PORT } from './wire.js';
import { groupByPort } from './modules/runner.js';
import { mapPool } from './pool.js';
import { sha256Hex, nowIso, unixToIso } from './util.js';
import { ProgressEmitter } from './events.js';
import { childLogger } from './logger.js';

const log = childLogger({ component: 'pipeline' });

const ModuleMetaSchema = z.object({
  referenceFrame: z.string(),
  timeSystem: z.string(),
  interpolationType: z.string().default('lagrange'),
  creationDate: z.string().nullable().default(null),
  validityStart: z.string().default(''),
  validityEnd: z.string().default(''),
  version: z.string().default('1'),
  stateCount: z.number().default(0),
  parserConfidence: z.number().default(1),
  source: z.string().default(''),
  stepSizeSeconds: z.number().default(0),
});

const ValidatorResultSchema = z.object({
  ok: z.boolean(),
  confidence: z.number(),
  stateCount: z.number().default(0),
  issues: z
    .array(z.object({ check: z.string(), severity: z.enum(['error', 'warning']), message: z.string() }))
    .default([]),
});

export interface ParsedEphemeris {
  resource: DiscoveredResource;
  metaJson: Uint8Array;
  statesFrame: Uint8Array;
}

export class Pipeline {
  readonly events = new ProgressEmitter();

  constructor(
    private readonly registry: ModuleRegistry,
    private readonly storage: StorageAdapter,
    private readonly http: HttpClient,
    private readonly config: Config,
  ) {}

  // --- EphemerisFetcher contract -------------------------------------------

  async discover(source: EphemerisSource): Promise<DiscoveredResource[]> {
    const cfg = sourceConfig(this.config, source.id);
    const ctx: SourceContext = { http: this.http, ...(cfg.limit ? { limit: cfg.limit } : {}) };
    return source.discover(ctx);
  }

  async fetch(source: EphemerisSource, resource: DiscoveredResource): Promise<RawEphemerisFile> {
    const cfg = sourceConfig(this.config, source.id);
    const res = await this.http.send({
      url: resource.url,
      method: resource.method ?? 'GET',
      retryCount: cfg.retryCount,
      timeoutMs: cfg.timeoutMs,
      ...(resource.body !== undefined ? { body: resource.body } : {}),
      ...(resource.headers ? { headers: resource.headers } : {}),
    });
    if (!res.ok) throw new Error(`fetch ${resource.url} -> HTTP ${res.status}`);
    return {
      resource,
      bytes: res.bytes,
      contentType: res.headers['content-type'] ?? null,
      checksum: sha256Hex(res.bytes),
      fetchedAt: nowIso(),
      sourceUrl: resource.url,
    };
  }

  async parse(source: EphemerisSource, raw: RawEphemerisFile): Promise<ParsedEphemeris> {
    const parser = this.registry.provider('parser', source.parserTag);
    if (!parser) throw new Error(`no parser module provides '${source.parserTag}'`);
    const frames = await parser.module.invoke(parser.descriptor.methodId, [
      { portId: PORT.RAW, payload: raw.bytes },
    ]);
    const byPort = groupByPort(frames);
    const metaJson = byPort.get(PORT.META)?.[0];
    const statesFrame = byPort.get(PORT.STATES)?.[0];
    if (!metaJson || !statesFrame) {
      throw new Error(`parser '${parser.descriptor.id}' did not emit meta+states`);
    }
    return { resource: raw.resource, metaJson, statesFrame };
  }

  async validate(parsed: ParsedEphemeris): Promise<ValidationResult> {
    const validator = this.registry.provider('validator', 'default') ?? this.registry.byKind('validator')[0];
    if (!validator) throw new Error('no validator module registered');
    const frames = await validator.module.invoke(validator.descriptor.methodId, [
      { portId: PORT.STATES, payload: parsed.statesFrame },
    ]);
    const resultFrame = groupByPort(frames).get('result')?.[0];
    if (!resultFrame) throw new Error('validator emitted no result');
    const parsedResult = ValidatorResultSchema.parse(decodeJsonFrame(resultFrame));
    return { ok: parsedResult.ok, issues: parsedResult.issues, confidence: parsedResult.confidence };
  }

  normalize(
    source: EphemerisSource,
    parsed: ParsedEphemeris,
    validation: ValidationResult,
  ): SatelliteEphemeris {
    const meta = ModuleMetaSchema.parse(decodeJsonFrame(parsed.metaJson));
    const states: StateVector[] = decodeStatesFrame(parsed.statesFrame);
    const hints = parsed.resource.hints;
    const genUnix = Number(hints.generatedUnix);
    return {
      satelliteName: hints.satelliteName || parsed.resource.id,
      noradId: parsed.resource.noradId,
      cosparId: hints.cosparId ?? null,
      operator: source.operator,
      source: source.id,
      referenceFrame: meta.referenceFrame as ReferenceFrame,
      timeSystem: meta.timeSystem as TimeSystem,
      interpolationType: meta.interpolationType as InterpolationType,
      validityStart: meta.validityStart || (states[0] ? unixToIso(states[0].epoch) : nowIso()),
      validityEnd:
        meta.validityEnd || (states.length ? unixToIso(states[states.length - 1]!.epoch) : nowIso()),
      creationDate: meta.creationDate,
      publicationDate: Number.isFinite(genUnix) && genUnix > 0 ? unixToIso(genUnix) : null,
      version: meta.version,
      states,
      originalMetadata: {
        ...hints,
        ephemerisSource: meta.source,
        stepSizeSeconds: meta.stepSizeSeconds,
        parserConfidence: meta.parserConfidence,
        validationConfidence: validation.confidence,
        validationIssues: validation.issues,
      },
    };
  }

  // --- Orchestration --------------------------------------------------------

  /** Discover, fetch, parse, validate, normalize, and store one source. */
  async refreshSource(source: EphemerisSource): Promise<SourceRefreshResult> {
    const result: SourceRefreshResult = {
      source: source.id,
      discovered: 0,
      fetched: 0,
      stored: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };

    let resources: DiscoveredResource[];
    try {
      resources = await this.discover(source);
    } catch (err) {
      result.errors.push(`discover: ${String(err)}`);
      this.events.emit('source:finish', { result });
      return result;
    }
    result.discovered = resources.length;
    this.events.emit('source:start', { source: source.id, total: resources.length });

    let done = 0;
    let bytes = 0;
    const emitProgress = (): void =>
      this.events.emit('source:progress', {
        source: source.id,
        done,
        total: resources.length,
        stored: result.stored,
        skipped: result.skipped,
        failed: result.failed,
        bytes,
      });

    // If a parser module handles this source, run the full pipeline; otherwise
    // archive the raw downloaded file (the fetcher still "works").
    const hasParser = this.registry.provider('parser', source.parserTag) !== undefined;

    await mapPool(resources, this.config.concurrency, async (resource) => {
      let status: 'stored' | 'skipped' | 'failed' = 'failed';
      try {
        const raw = await this.fetch(source, resource);
        bytes += raw.bytes.byteLength;
        result.fetched++;

        if (hasParser) {
          if (await this.storage.hasChecksum(source.id, raw.checksum)) {
            result.skipped++;
            status = 'skipped';
          } else {
            const parsed = await this.parse(source, raw);
            const validation = await this.validate(parsed);
            const ephemeris = this.normalize(source, parsed, validation);
            const { created } = await this.storage.store({
              ephemeris,
              validation,
              rawBytes: raw.bytes,
              checksum: raw.checksum,
              sourceUrl: raw.sourceUrl,
              fetchedAt: raw.fetchedAt,
              contentExt: source.contentExt,
            });
            status = created ? 'stored' : 'skipped';
            if (created) result.stored++;
            else result.skipped++;
          }
        } else {
          if (await this.storage.hasRawChecksum(source.id, raw.checksum)) {
            result.skipped++;
            status = 'skipped';
          } else {
            const { created } = await this.storage.storeRaw({
              source: source.id,
              resourceId: resource.id,
              noradId: resource.noradId,
              satelliteName: resource.hints.satelliteName ?? null,
              url: raw.sourceUrl,
              checksum: raw.checksum,
              bytes: raw.bytes,
              contentExt: resource.ext ?? source.contentExt,
              fetchedAt: raw.fetchedAt,
            });
            status = created ? 'stored' : 'skipped';
            if (created) result.stored++;
            else result.skipped++;
          }
        }
      } catch (err) {
        result.failed++;
        status = 'failed';
        const msg = `${resource.id}: ${String(err)}`;
        if (result.errors.length < 25) result.errors.push(msg);
        log.warn({ source: source.id, resource: resource.id, err: String(err) }, 'resource failed');
      } finally {
        done++;
        this.events.emit('resource:done', { source: source.id, id: resource.id, status });
        emitProgress();
      }
    });

    this.events.emit('source:finish', { result });
    return result;
  }
}
