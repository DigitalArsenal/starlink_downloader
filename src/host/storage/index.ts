/** Storage abstraction — implemented by SQLite (and pluggable to Postgres). */
import type {
  SatelliteEphemeris,
  StateVector,
  StoredEphemerisRecord,
  ValidationResult,
} from '../types.js';

export interface StoreInput {
  ephemeris: SatelliteEphemeris;
  validation: ValidationResult;
  rawBytes: Uint8Array;
  checksum: string;
  sourceUrl: string;
  fetchedAt: string;
  contentExt: string;
}

/** Input for archiving a raw downloaded file without (yet) parsing it. */
export interface RawStoreInput {
  source: string;
  resourceId: string;
  noradId: number | null;
  satelliteName: string | null;
  url: string;
  checksum: string;
  bytes: Uint8Array;
  contentExt: string;
  fetchedAt: string;
}

export interface StorageAdapter {
  init(): Promise<void>;
  /**
   * Archive a raw downloaded file with provenance, without parsing it. Used by
   * fetchers whose format does not yet have a parser module. Never overwrites;
   * de-duplicates by (source, checksum).
   */
  storeRaw(input: RawStoreInput): Promise<{ created: boolean }>;
  hasRawChecksum(source: string, checksum: string): Promise<boolean>;
  listRaw(): Promise<Array<{ source: string; files: number; bytes: number }>>;
  /**
   * Archive a normalized ephemeris as a NEW version. Never overwrites a prior
   * version. If an identical (source, satellite, checksum) record already
   * exists, returns it unchanged (and reports `created: false`).
   */
  store(input: StoreInput): Promise<{ record: StoredEphemerisRecord; created: boolean }>;
  /** True if this exact content is already archived. */
  hasChecksum(source: string, checksum: string): Promise<boolean>;
  listSources(): Promise<Array<{ source: string; satellites: number; versions: number }>>;
  listSatellites(source?: string): Promise<
    Array<{ noradId: number | null; satelliteName: string; source: string; versions: number }>
  >;
  getVersions(noradId: number, source?: string): Promise<StoredEphemerisRecord[]>;
  /** Latest archived version for a satellite (by noradId). */
  latest(noradId: number, source?: string): Promise<StoredEphemerisRecord | null>;
  /** Load the full ephemeris (with states) for a stored record id. */
  load(recordId: number): Promise<SatelliteEphemeris | null>;
  close(): Promise<void>;
}
