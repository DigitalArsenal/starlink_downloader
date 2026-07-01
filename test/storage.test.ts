import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlatSqlStorage } from '../src/host/storage/flatsql.js';
import type { SatelliteEphemeris, ValidationResult } from '../src/host/types.js';

function ephem(noradId: number, n: number): SatelliteEphemeris {
  const states = Array.from({ length: n }, (_, i) => ({
    epoch: 1000 + i * 60,
    positionMeters: [7e6 + i, 0, 0] as [number, number, number],
    velocityMetersPerSecond: [0, 7500, 0] as [number, number, number],
  }));
  return {
    satelliteName: `SAT-${noradId}`,
    noradId,
    cosparId: null,
    operator: 'Test',
    source: 'test-source',
    referenceFrame: 'J2000',
    timeSystem: 'UTC',
    interpolationType: 'hermite',
    validityStart: '2026-01-01T00:00:00Z',
    validityEnd: '2026-01-02T00:00:00Z',
    creationDate: '2026-01-01T00:00:00Z',
    publicationDate: null,
    version: '1',
    states,
    originalMetadata: { foo: 'bar' },
  };
}

const validation: ValidationResult = { ok: true, issues: [], confidence: 1 };

describe('FlatSqlStorage', () => {
  let dir: string;
  let storage: FlatSqlStorage;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ephem-store-'));
    storage = new FlatSqlStorage(dir);
    await storage.init();
  });
  afterAll(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores a record and assigns version 1', async () => {
    const { record, created } = await storage.store({
      ephemeris: ephem(101, 5),
      validation,
      rawBytes: new TextEncoder().encode('raw-A'),
      checksum: 'cksum-A',
      sourceUrl: 'http://x/a',
      fetchedAt: '2026-01-01T00:00:00Z',
      contentExt: 'txt',
    });
    expect(created).toBe(true);
    expect(record.version).toBe('1');
    expect(record.stateCount).toBe(5);
  });

  it('de-duplicates identical content (same checksum)', async () => {
    const { created } = await storage.store({
      ephemeris: ephem(101, 5),
      validation,
      rawBytes: new TextEncoder().encode('raw-A'),
      checksum: 'cksum-A',
      sourceUrl: 'http://x/a',
      fetchedAt: '2026-01-01T01:00:00Z',
      contentExt: 'txt',
    });
    expect(created).toBe(false);
    expect(await storage.hasChecksum('test-source', 'cksum-A')).toBe(true);
  });

  it('never overwrites: new content becomes version 2', async () => {
    const { record, created } = await storage.store({
      ephemeris: ephem(101, 7),
      validation,
      rawBytes: new TextEncoder().encode('raw-B'),
      checksum: 'cksum-B',
      sourceUrl: 'http://x/b',
      fetchedAt: '2026-01-02T00:00:00Z',
      contentExt: 'txt',
    });
    expect(created).toBe(true);
    expect(record.version).toBe('2');
    const versions = await storage.getVersions(101);
    expect(versions.map((v) => v.version)).toEqual(['2', '1']);
  });

  it('reports latest and round-trips states', async () => {
    const latest = await storage.latest(101);
    expect(latest?.version).toBe('2');
    const loaded = await storage.load(latest!.id);
    expect(loaded?.states.length).toBe(7);
    expect(loaded?.states[0]?.positionMeters[0]).toBeCloseTo(7e6, 3);
    expect(loaded?.originalMetadata.foo).toBe('bar');
  });

  it('lists sources and satellites', async () => {
    const sources = await storage.listSources();
    expect(sources.find((s) => s.source === 'test-source')?.versions).toBe(2);
    const sats = await storage.listSatellites('test-source');
    expect(sats.find((s) => s.noradId === 101)?.versions).toBe(2);
  });

  it('archives raw files and de-duplicates them', async () => {
    const r1 = await storage.storeRaw({
      source: 'raw-source',
      resourceId: 'file.sp3.gz',
      noradId: null,
      satelliteName: 'GNSS',
      url: 'http://x/file.sp3.gz',
      checksum: 'raw-1',
      bytes: new Uint8Array([1, 2, 3, 4]),
      contentExt: 'sp3.gz',
      fetchedAt: '2026-01-01T00:00:00Z',
    });
    expect(r1.created).toBe(true);
    const r2 = await storage.storeRaw({
      source: 'raw-source',
      resourceId: 'file.sp3.gz',
      noradId: null,
      satelliteName: 'GNSS',
      url: 'http://x/file.sp3.gz',
      checksum: 'raw-1',
      bytes: new Uint8Array([1, 2, 3, 4]),
      contentExt: 'sp3.gz',
      fetchedAt: '2026-01-01T01:00:00Z',
    });
    expect(r2.created).toBe(false);
    const raw = await storage.listRaw();
    expect(raw.find((x) => x.source === 'raw-source')?.files).toBe(1);
  });
});

describe('FlatSqlStorage persistence', () => {
  it('reloads the archive across instances', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ephem-persist-'));
    try {
      const a = new FlatSqlStorage(dir);
      await a.init();
      await a.store({
        ephemeris: ephem(202, 6),
        validation,
        rawBytes: new TextEncoder().encode('raw'),
        checksum: 'persist-1',
        sourceUrl: 'http://x',
        fetchedAt: '2026-01-01T00:00:00Z',
        contentExt: 'txt',
      });
      await a.close();

      const b = new FlatSqlStorage(dir);
      await b.init();
      const latest = await b.latest(202);
      expect(latest?.stateCount).toBe(6);
      const loaded = await b.load(latest!.id);
      expect(loaded?.states.length).toBe(6);
      // dedupe index is rebuilt from the persisted archive on reload
      expect(await b.hasChecksum('test-source', 'persist-1')).toBe(true);
      expect(await b.hasChecksum('test-source', 'never')).toBe(false);
      await b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('FlatSqlStorage (producer, standard) routing', () => {
  function ephemFrom(source: string, noradId: number): SatelliteEphemeris {
    return { ...ephem(noradId, 4), source };
  }

  it('routes records into per-producer tables and reads across them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ephem-routing-'));
    try {
      const s = new FlatSqlStorage(dir);
      await s.init();

      await s.store({
        ephemeris: ephemFrom('spacex-starlink', 301),
        validation,
        rawBytes: new TextEncoder().encode('sx'),
        checksum: 'sx-1',
        sourceUrl: 'http://sx/1',
        fetchedAt: '2026-01-01T00:00:00Z',
        contentExt: 'txt',
      });
      await s.store({
        ephemeris: ephemFrom('celestrak', 302),
        validation,
        rawBytes: new TextEncoder().encode('ct'),
        checksum: 'ct-1',
        sourceUrl: 'http://ct/1',
        fetchedAt: '2026-01-01T00:00:00Z',
        contentExt: 'txt',
      });

      // Each producer's records live in their own (short-hashed) store table.
      const store = (s as unknown as {
        flatStore: { iterateRecords(): Iterable<{ header: { tableName: string } }> };
      }).flatStore;
      const tables = new Set<string>();
      for (const rec of store.iterateRecords()) tables.add(rec.header.tableName);
      expect(tables.size).toBe(2); // two producers -> two distinct tables
      for (const t of tables) expect(t.startsWith('E@')).toBe(true);

      // Reads span every producer table.
      const sources = await s.listSources();
      expect(sources.map((x) => x.source).sort()).toEqual(['celestrak', 'spacex-starlink']);
      const sx = await s.latest(301);
      const ct = await s.latest(302);
      expect((await s.load(sx!.id))?.source).toBe('spacex-starlink');
      expect((await s.load(ct!.id))?.source).toBe('celestrak');
      await s.close();

      // Reload rebuilds the index across producer tables.
      const s2 = new FlatSqlStorage(dir);
      await s2.init();
      expect((await s2.listSources()).length).toBe(2);
      expect(await s2.latest(301)).not.toBeNull();
      expect(await s2.latest(302)).not.toBeNull();
      await s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
