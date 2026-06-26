/**
 * Core domain model for the ephemeris system.
 *
 * Everything internal is stored in SI units (metres, metres/second) with epochs
 * expressed as Unix seconds (f64) in the satellite's declared time system. The
 * original metadata (frame, time system, source identifiers) is preserved.
 */
import { z } from 'zod';

/** Reference frames the system understands. */
export const REFERENCE_FRAMES = ['GCRF', 'ICRF', 'J2000', 'EME2000', 'TEME', 'ITRF'] as const;
export type ReferenceFrame = (typeof REFERENCE_FRAMES)[number];

/** Time systems the system understands. */
export const TIME_SYSTEMS = ['UTC', 'TAI', 'TT', 'GPS', 'TDB'] as const;
export type TimeSystem = (typeof TIME_SYSTEMS)[number];

/** Interpolation schemes exposed by interpolator modules. */
export const INTERPOLATION_TYPES = ['lagrange', 'hermite', 'cubic-spline', 'linear'] as const;
export type InterpolationType = (typeof INTERPOLATION_TYPES)[number];

/** A single state vector. SI units; epoch is Unix seconds in the ephemeris time system. */
export interface StateVector {
  /** Unix seconds (f64) in the ephemeris {@link TimeSystem}. */
  epoch: number;
  /** Position in metres, [x, y, z]. */
  positionMeters: [number, number, number];
  /** Velocity in metres/second, [vx, vy, vz]. */
  velocityMetersPerSecond: [number, number, number];
}

/** The normalized internal ephemeris model. */
export interface SatelliteEphemeris {
  satelliteName: string;
  noradId: number | null;
  cosparId: string | null;
  operator: string;
  source: string;
  referenceFrame: ReferenceFrame;
  timeSystem: TimeSystem;
  interpolationType: InterpolationType;
  /** ISO-8601 UTC. */
  validityStart: string;
  /** ISO-8601 UTC. */
  validityEnd: string;
  /** ISO-8601 UTC. */
  creationDate: string | null;
  /** ISO-8601 UTC. */
  publicationDate: string | null;
  version: string;
  states: StateVector[];
  /** Raw, source-specific metadata preserved verbatim from the parser. */
  originalMetadata: Record<string, unknown>;
}

/** Metadata emitted by a parser module in its `meta` output frame (JSON). */
export const ParserMetaSchema = z.object({
  satelliteName: z.string(),
  noradId: z.number().int().nullable().optional(),
  cosparId: z.string().nullable().optional(),
  operator: z.string(),
  source: z.string(),
  referenceFrame: z.enum(REFERENCE_FRAMES),
  timeSystem: z.enum(TIME_SYSTEMS),
  interpolationType: z.enum(INTERPOLATION_TYPES).default('lagrange'),
  creationDate: z.string().nullable().optional(),
  publicationDate: z.string().nullable().optional(),
  version: z.string().default('1'),
  stateCount: z.number().int().nonnegative(),
  parserConfidence: z.number().min(0).max(1).default(1),
  originalMetadata: z.record(z.unknown()).default({}),
});
export type ParserMeta = z.infer<typeof ParserMetaSchema>;

/** A resource discovered for a source that can be fetched. */
export interface DiscoveredResource {
  /** Stable id within the source (usually the filename or catalog id). */
  id: string;
  /** Absolute URL to fetch. */
  url: string;
  /** NORAD id if derivable before fetch (else null). */
  noradId: number | null;
  /** Per-resource file extension (overrides the source default for archiving). */
  ext?: string;
  /** HTTP method (default GET). Some authed APIs require POST. */
  method?: string;
  /** Request body for non-GET fetches (e.g. EDC form-encoded download). */
  body?: string;
  /** Per-resource HTTP headers (e.g. auth Bearer token or session cookie). */
  headers?: Record<string, string>;
  /** Free-form hints passed to the parser (e.g. filename-derived fields). */
  hints: Record<string, string>;
}

/** The raw bytes of a fetched resource plus provenance. */
export interface RawEphemerisFile {
  resource: DiscoveredResource;
  bytes: Uint8Array;
  contentType: string | null;
  /** SHA-256 hex of {@link bytes}. */
  checksum: string;
  fetchedAt: string;
  sourceUrl: string;
}

/** One validation finding. */
export interface ValidationIssue {
  check: string;
  severity: 'error' | 'warning';
  message: string;
}

/** Result of running the validator modules over a parsed ephemeris. */
export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** Aggregate parser+validation confidence in [0,1]. */
  confidence: number;
}

/** A stored, versioned ephemeris record. */
export interface StoredEphemerisRecord {
  id: number;
  noradId: number | null;
  satelliteName: string;
  source: string;
  version: string;
  checksum: string;
  sourceUrl: string;
  fetchedAt: string;
  validityStart: string;
  validityEnd: string;
  stateCount: number;
  valid: boolean;
}

/** Result of refreshing a single source. */
export interface SourceRefreshResult {
  source: string;
  discovered: number;
  fetched: number;
  stored: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/** Result of a full refresh across sources. */
export interface RefreshResult {
  startedAt: string;
  finishedAt: string;
  sources: SourceRefreshResult[];
}
