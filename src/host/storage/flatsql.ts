/**
 * FlatSQL storage adapter — the archive of record.
 *
 * Backed by FlatSQL's append-only `StackedFlatBufferStore` plus a `FlatcAccessor`
 * driven by the DigitalArsenal `flatc-wasm`. There is **no SQL**: rows are
 * FlatBuffers (the `EphemRecord` schema below), reads iterate the store, and the
 * whole archive persists as a self-describing stacked-FlatBuffer file.
 *
 * Parsed ephemerides are stored as genuine **spacedatastandards CCSDS OEM**
 * FlatBuffers (`writeFB`/`readFB`); raw fetched files are archived to disk with
 * a provenance record (kind = "raw"). The archive never overwrites — every
 * `store`/`storeRaw` appends a new record; identical content (source + checksum)
 * is de-duplicated.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { FlatcRunner } from 'flatc-wasm';
import { FlatcAccessor, StackedFlatBufferStore } from 'flatsql';
import { standards, writeFB, readFB } from 'spacedatastandards.org';
import type { StorageAdapter, StoreInput, RawStoreInput } from './index.js';
import type {
  SatelliteEphemeris,
  StateVector,
  StoredEphemerisRecord,
  ReferenceFrame,
  TimeSystem,
  InterpolationType,
} from '../types.js';
import { childLogger } from '../logger.js';

const log = childLogger({ component: 'flatsql-storage' });

/** Schema root type used by the accessor (fixed). */
const SCHEMA_TYPE = 'EphemRecord';
/** Standard abbreviation for the EphemRecord table in routed store-table names. */
const STANDARD_ABBR = 'E';

/**
 * Route a record to its (producer, standard) store table (WS7.4). Each
 * producer's records live in their own table rather than one shared table,
 * while reads span every table (iterateRecords). The StackedFlatBufferStore caps
 * table names at 15 bytes, so the producer is encoded as a short stable hash —
 * `E@<12-hex>` (standard 'E' = EphemRecord). Distinct producers yield distinct
 * tables; the full producer is preserved in each record's `source` field.
 */
function producerStandardTable(source: string): string {
  const producer = (source ?? '').trim() || 'unknown';
  const hash = createHash('sha256').update(producer).digest('hex').slice(0, 12);
  return `${STANDARD_ABBR}@${hash}`;
}

const SCHEMA = `
table EphemRecord {
  source:string;
  resourceId:string;
  noradId:uint;
  hasNorad:bool;
  satelliteName:string;
  cosparId:string;
  operator:string;
  url:string;
  checksum:string;
  fetchedAt:string;
  version:uint;
  kind:string;
  format:string;
  referenceFrame:string;
  timeSystem:string;
  interpolationType:string;
  validityStart:string;
  validityEnd:string;
  creationDate:string;
  publicationDate:string;
  stateCount:uint;
  valid:bool;
  byteSize:uint;
  rawPath:string;
  metaJson:string;
  oem:[ubyte];
}
root_type EphemRecord;
`;

interface RecordFields {
  source: string;
  resourceId: string;
  noradId: number;
  hasNorad: boolean;
  satelliteName: string;
  cosparId: string;
  operator: string;
  url: string;
  checksum: string;
  fetchedAt: string;
  version: number;
  kind: string;
  format: string;
  referenceFrame: string;
  timeSystem: string;
  interpolationType: string;
  validityStart: string;
  validityEnd: string;
  creationDate: string;
  publicationDate: string;
  stateCount: number;
  valid: boolean;
  byteSize: number;
  rawPath: string;
  metaJson: string;
  oem: number[];
}

interface Summary {
  seq: number;
  source: string;
  noradId: number | null;
  satelliteName: string;
  version: number;
  checksum: string;
  url: string;
  fetchedAt: string;
  validityStart: string;
  validityEnd: string;
  stateCount: number;
  valid: boolean;
  kind: string;
  byteSize: number;
}

function summaryToRecord(s: Summary): StoredEphemerisRecord {
  return {
    id: s.seq,
    noradId: s.noradId,
    satelliteName: s.satelliteName,
    source: s.source,
    version: String(s.version),
    checksum: s.checksum,
    sourceUrl: s.url,
    fetchedAt: s.fetchedAt,
    validityStart: s.validityStart,
    validityEnd: s.validityEnd,
    stateCount: s.stateCount,
    valid: s.valid,
  };
}

/** Build a spacedatastandards CCSDS OEM FlatBuffer from a normalized ephemeris. */
function buildOemFlatBuffer(e: SatelliteEphemeris): Uint8Array {
  const oemNs = standards.OEM as unknown as {
    OEMT: new (...a: unknown[]) => Record<string, unknown>;
    ephemerisDataBlockT: new () => Record<string, unknown>;
    ephemerisDataLineT: new (...a: unknown[]) => Record<string, unknown>;
    timingStandard?: Record<string, number>;
  };
  const lines = e.states.map(
    (s) =>
      new oemNs.ephemerisDataLineT(
        new Date(s.epoch * 1000).toISOString(),
        s.positionMeters[0] / 1000,
        s.positionMeters[1] / 1000,
        s.positionMeters[2] / 1000,
        s.velocityMetersPerSecond[0] / 1000,
        s.velocityMetersPerSecond[1] / 1000,
        s.velocityMetersPerSecond[2] / 1000,
      ),
  );
  const block = new oemNs.ephemerisDataBlockT();
  block.CENTER_NAME = 'EARTH';
  block.START_TIME = e.validityStart;
  block.STOP_TIME = e.validityEnd;
  block.INTERPOLATION = e.interpolationType;
  block.EPHEMERIS_DATA_LINES = lines;
  const ts = oemNs.timingStandard?.[e.timeSystem];
  if (typeof ts === 'number') block.TIME_SYSTEM = ts;
  const oem = new oemNs.OEMT(null, 2.0, e.creationDate, e.operator, [block]);
  return new Uint8Array(writeFB(oem));
}

/** Reconstruct SI state vectors from a stored OEM FlatBuffer. */
function statesFromOem(oemBytes: Uint8Array): StateVector[] {
  const decoded = readFB(oemBytes) as Array<{
    EPHEMERIS_DATA_BLOCK?: Array<{ EPHEMERIS_DATA_LINES?: Array<Record<string, unknown>> }>;
  }>;
  const block = decoded[0]?.EPHEMERIS_DATA_BLOCK?.[0];
  const lines = block?.EPHEMERIS_DATA_LINES ?? [];
  return lines.map((l) => {
    const epochRaw = l.EPOCH;
    const epoch =
      typeof epochRaw === 'string' ? Date.parse(epochRaw) / 1000 : Number(epochRaw) || 0;
    const n = (v: unknown): number => Number(v) || 0;
    return {
      epoch,
      positionMeters: [n(l.X) * 1000, n(l.Y) * 1000, n(l.Z) * 1000],
      velocityMetersPerSecond: [n(l.X_DOT) * 1000, n(l.Y_DOT) * 1000, n(l.Z_DOT) * 1000],
    };
  });
}

export class FlatSqlStorage implements StorageAdapter {
  private accessor!: FlatcAccessor;
  private flatStore!: StackedFlatBufferStore;
  private readonly archivePath: string;
  private readonly rawDir: string;
  private readonly summaries: Summary[] = [];
  private readonly checksums = new Map<string, Set<string>>();
  private readonly maxVersion = new Map<string, number>();
  private nextSeq = 0;
  private dirty = false;
  private sinceFlush = 0;

  constructor(private readonly dataDir: string) {
    this.archivePath = join(dataDir, 'archive.fsb');
    this.rawDir = join(dataDir, 'raw');
  }

  async init(): Promise<void> {
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.rawDir, { recursive: true });
    const flatc = await FlatcRunner.init();
    this.accessor = new FlatcAccessor(flatc as never, SCHEMA, 'EphemRecord.fbs');

    if (existsSync(this.archivePath)) {
      this.flatStore = StackedFlatBufferStore.fromData(new Uint8Array(readFileSync(this.archivePath)));
      // Records live in per-producer tables (EphemRecord@<producer>) plus, for
      // legacy archives, the shared EphemRecord table. iterateRecords spans them
      // all — every record in this store is an EphemRecord.
      for (const rec of this.flatStore.iterateRecords()) {
        const obj = this.accessor.toJSON(rec.data) as Partial<RecordFields>;
        this.indexSummary(Number(rec.header.sequence), obj);
      }
      this.nextSeq = Number(this.flatStore.getRecordCount());
    } else {
      this.flatStore = new StackedFlatBufferStore('ephem');
      this.nextSeq = 0;
    }
    log.debug({ records: this.summaries.length }, 'flatsql archive ready');
  }

  private indexSummary(seq: number, obj: Partial<RecordFields>): void {
    const noradId = obj.hasNorad ? Number(obj.noradId) : null;
    const summary: Summary = {
      seq,
      source: obj.source ?? '',
      noradId,
      satelliteName: obj.satelliteName ?? '',
      version: Number(obj.version ?? 1),
      checksum: obj.checksum ?? '',
      url: obj.url ?? '',
      fetchedAt: obj.fetchedAt ?? '',
      validityStart: obj.validityStart ?? '',
      validityEnd: obj.validityEnd ?? '',
      stateCount: Number(obj.stateCount ?? 0),
      valid: Boolean(obj.valid),
      kind: obj.kind ?? 'raw',
      byteSize: Number(obj.byteSize ?? 0),
    };
    this.summaries.push(summary);
    const set = this.checksums.get(summary.source) ?? new Set();
    set.add(summary.checksum);
    this.checksums.set(summary.source, set);
    const vk = `${summary.source}|${noradId ?? -1}`;
    this.maxVersion.set(vk, Math.max(this.maxVersion.get(vk) ?? 0, summary.version));
  }

  private append(fields: RecordFields): number {
    const bytes = this.accessor.fromJSON(fields as unknown as Record<string, unknown>, SCHEMA_TYPE);
    // Route the record to its producer's table. The store assigns a global
    // sequence across all tables that matches nextSeq (used as the record id).
    this.flatStore.append(producerStandardTable(fields.source), bytes);
    const seq = this.nextSeq++;
    this.indexSummary(seq, fields);
    this.dirty = true;
    if (++this.sinceFlush >= 200) this.flushSync();
    return seq;
  }

  private flushSync(): void {
    if (!this.dirty) return;
    writeFileSync(this.archivePath, this.flatStore.getData());
    this.dirty = false;
    this.sinceFlush = 0;
  }

  private nextVersion(source: string, noradId: number | null): number {
    const vk = `${source}|${noradId ?? -1}`;
    return (this.maxVersion.get(vk) ?? 0) + 1;
  }

  private writeRaw(source: string, checksum: string, ext: string, bytes: Uint8Array): string {
    const dir = join(this.rawDir, source);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${checksum}.${ext}`);
    if (!existsSync(p)) writeFileSync(p, bytes);
    return p;
  }

  async hasChecksum(source: string, checksum: string): Promise<boolean> {
    return this.checksums.get(source)?.has(checksum) ?? false;
  }

  hasRawChecksum(source: string, checksum: string): Promise<boolean> {
    return this.hasChecksum(source, checksum);
  }

  async store(input: StoreInput): Promise<{ record: StoredEphemerisRecord; created: boolean }> {
    const { ephemeris: e, validation, checksum } = input;
    if (await this.hasChecksum(e.source, checksum)) {
      const existing = this.summaries.find((s) => s.source === e.source && s.checksum === checksum)!;
      return { record: summaryToRecord(existing), created: false };
    }
    const version = this.nextVersion(e.source, e.noradId);
    const rawPath = this.writeRaw(e.source, checksum, input.contentExt, input.rawBytes);
    const oem = buildOemFlatBuffer(e);
    const seq = this.append({
      source: e.source,
      resourceId: e.satelliteName,
      noradId: e.noradId ?? 0,
      hasNorad: e.noradId !== null,
      satelliteName: e.satelliteName,
      cosparId: e.cosparId ?? '',
      operator: e.operator,
      url: input.sourceUrl,
      checksum,
      fetchedAt: input.fetchedAt,
      version,
      kind: 'ephemeris',
      format: input.contentExt,
      referenceFrame: e.referenceFrame,
      timeSystem: e.timeSystem,
      interpolationType: e.interpolationType,
      validityStart: e.validityStart,
      validityEnd: e.validityEnd,
      creationDate: e.creationDate ?? '',
      publicationDate: e.publicationDate ?? '',
      stateCount: e.states.length,
      valid: validation.ok,
      byteSize: input.rawBytes.byteLength,
      rawPath,
      metaJson: JSON.stringify({ ...e.originalMetadata, validation }),
      oem: Array.from(oem),
    });
    const summary = this.summaries.find((s) => s.seq === seq)!;
    return { record: summaryToRecord(summary), created: true };
  }

  async storeRaw(input: RawStoreInput): Promise<{ created: boolean }> {
    if (await this.hasRawChecksum(input.source, input.checksum)) return { created: false };
    const version = this.nextVersion(input.source, input.noradId);
    const rawPath = this.writeRaw(input.source, input.checksum, input.contentExt, input.bytes);
    this.append({
      source: input.source,
      resourceId: input.resourceId,
      noradId: input.noradId ?? 0,
      hasNorad: input.noradId !== null,
      satelliteName: input.satelliteName ?? input.resourceId,
      cosparId: '',
      operator: '',
      url: input.url,
      checksum: input.checksum,
      fetchedAt: input.fetchedAt,
      version,
      kind: 'raw',
      format: input.contentExt,
      referenceFrame: '',
      timeSystem: '',
      interpolationType: '',
      validityStart: '',
      validityEnd: '',
      creationDate: '',
      publicationDate: '',
      stateCount: 0,
      valid: true,
      byteSize: input.bytes.byteLength,
      rawPath,
      metaJson: '',
      oem: [],
    });
    return { created: true };
  }

  async listRaw(): Promise<Array<{ source: string; files: number; bytes: number }>> {
    const agg = new Map<string, { files: number; bytes: number }>();
    for (const s of this.summaries) {
      if (s.kind !== 'raw') continue;
      const a = agg.get(s.source) ?? { files: 0, bytes: 0 };
      a.files++;
      a.bytes += s.byteSize;
      agg.set(s.source, a);
    }
    return [...agg.entries()].map(([source, a]) => ({ source, ...a })).sort((x, y) => x.source.localeCompare(y.source));
  }

  async listSources(): Promise<Array<{ source: string; satellites: number; versions: number }>> {
    const bySource = new Map<string, { sats: Set<string>; versions: number }>();
    for (const s of this.summaries) {
      if (s.kind !== 'ephemeris') continue;
      const e = bySource.get(s.source) ?? { sats: new Set(), versions: 0 };
      e.sats.add(String(s.noradId ?? s.satelliteName));
      e.versions++;
      bySource.set(s.source, e);
    }
    return [...bySource.entries()]
      .map(([source, e]) => ({ source, satellites: e.sats.size, versions: e.versions }))
      .sort((x, y) => x.source.localeCompare(y.source));
  }

  async listSatellites(
    source?: string,
  ): Promise<Array<{ noradId: number | null; satelliteName: string; source: string; versions: number }>> {
    const key = (s: Summary): string => `${s.source}|${s.noradId ?? s.satelliteName}`;
    const m = new Map<string, { noradId: number | null; satelliteName: string; source: string; versions: number }>();
    for (const s of this.summaries) {
      if (s.kind !== 'ephemeris') continue;
      if (source && s.source !== source) continue;
      const k = key(s);
      const e = m.get(k) ?? { noradId: s.noradId, satelliteName: s.satelliteName, source: s.source, versions: 0 };
      e.versions++;
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => a.satelliteName.localeCompare(b.satelliteName));
  }

  async getVersions(noradId: number, source?: string): Promise<StoredEphemerisRecord[]> {
    return this.summaries
      .filter((s) => s.kind === 'ephemeris' && s.noradId === noradId && (!source || s.source === source))
      .sort((a, b) => b.version - a.version)
      .map(summaryToRecord);
  }

  async latest(noradId: number, source?: string): Promise<StoredEphemerisRecord | null> {
    const matches = this.summaries.filter(
      (s) => s.kind === 'ephemeris' && s.noradId === noradId && (!source || s.source === source),
    );
    if (matches.length === 0) return null;
    matches.sort((a, b) => b.version - a.version || b.seq - a.seq);
    return summaryToRecord(matches[0]!);
  }

  async load(recordId: number): Promise<SatelliteEphemeris | null> {
    const summary = this.summaries.find((s) => s.seq === recordId);
    if (!summary) return null;
    for (const rec of this.flatStore.iterateRecords()) {
      if (Number(rec.header.sequence) !== recordId) continue;
      const obj = this.accessor.toJSON(rec.data) as Partial<RecordFields>;
      const oemBytes = Uint8Array.from(obj.oem ?? []);
      const states = oemBytes.length > 0 ? statesFromOem(oemBytes) : [];
      let meta: Record<string, unknown> = {};
      try {
        meta = obj.metaJson ? (JSON.parse(obj.metaJson) as Record<string, unknown>) : {};
      } catch {
        /* ignore */
      }
      return {
        satelliteName: obj.satelliteName ?? '',
        noradId: obj.hasNorad ? Number(obj.noradId) : null,
        cosparId: obj.cosparId || null,
        operator: obj.operator ?? '',
        source: obj.source ?? '',
        referenceFrame: (obj.referenceFrame || 'J2000') as ReferenceFrame,
        timeSystem: (obj.timeSystem || 'UTC') as TimeSystem,
        interpolationType: (obj.interpolationType || 'lagrange') as InterpolationType,
        validityStart: obj.validityStart ?? '',
        validityEnd: obj.validityEnd ?? '',
        creationDate: obj.creationDate || null,
        publicationDate: obj.publicationDate || null,
        version: String(obj.version ?? 1),
        states,
        originalMetadata: meta,
      };
    }
    return null;
  }

  async close(): Promise<void> {
    this.flushSync();
  }
}
