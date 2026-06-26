/** Source registry — each source knows how to discover its fetchable resources. */
import type { DiscoveredResource } from '../types.js';
import type { HttpClient } from '../http.js';
import { starlinkSource } from './starlink.js';
import { onewebSource } from './oneweb.js';
import { planetSource } from './planet.js';
import { issSource } from './iss.js';
import { sesSource } from './ses.js';
import { intelsatSource } from './intelsat.js';
import { telesatSource } from './telesat.js';
import { cssSource } from './css.js';
import { gpsSource, glonassSource } from './gnss.js';
import { esaPodSource } from './esa-pod.js';
import { eumetsatSource } from './eumetsat.js';
import { cpfSource } from './cpf.js';
import { spireSource } from './spire.js';
import { spaceTrackSource } from './spacetrack.js';
import { vimpelSource } from './vimpel.js';

export interface SourceContext {
  http: HttpClient;
  /** Optional cap on discovered resources (for incremental / demo refreshes). */
  limit?: number;
}

export interface EphemerisSource {
  /** Stable source id, also the `provides` tag of its parser module. */
  id: string;
  name: string;
  operator: string;
  /** Parser module `provides` tag used to parse this source's files. */
  parserTag: string;
  /** File extension for archived raw files. */
  contentExt: string;
  /** Primary host (for rate limiting), e.g. 'api.starlink.com'. */
  host: string;
  discover(ctx: SourceContext): Promise<DiscoveredResource[]>;
}

const ALL: EphemerisSource[] = [
  starlinkSource,
  onewebSource,
  planetSource,
  issSource,
  sesSource,
  intelsatSource,
  telesatSource,
  cssSource,
  gpsSource,
  glonassSource,
  esaPodSource,
  eumetsatSource,
  cpfSource,
  // Credentialed sources — inert unless their .env credentials are present.
  spireSource,
  spaceTrackSource,
  vimpelSource,
];

export function listSources(): EphemerisSource[] {
  return ALL;
}

export function getSource(id: string): EphemerisSource | undefined {
  return ALL.find((s) => s.id === id);
}
