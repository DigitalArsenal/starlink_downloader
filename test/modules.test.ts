import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModuleRegistry } from '../src/host/modules/registry.js';
import { groupByPort } from '../src/host/modules/runner.js';
import { decodeStatesFrame, decodeJsonFrame, PORT } from '../src/host/wire.js';
import { interpolateStates } from '../src/host/interpolate.js';
import { PACKAGE_ROOT } from '../src/host/paths.js';

const FIXTURE = join(PACKAGE_ROOT, 'test', 'fixtures', 'starlink_sample.txt');
const RE = 6378137;

let registry: ModuleRegistry;
let statesFrame: Uint8Array;

describe('C++/WASM compute modules', () => {
  beforeAll(async () => {
    registry = ModuleRegistry.discover();
    await registry.buildAll(); // no-op if AOT artifacts are present
    const parser = registry.provider('parser', 'spacex-starlink')!;
    const raw = new Uint8Array(readFileSync(FIXTURE));
    const frames = await parser.module.invoke(parser.descriptor.methodId, [
      { portId: PORT.RAW, payload: raw },
    ]);
    const byPort = groupByPort(frames);
    statesFrame = byPort.get(PORT.STATES)![0]!;
    const meta = decodeJsonFrame<{ referenceFrame: string; timeSystem: string; stateCount: number }>(
      byPort.get(PORT.META)![0]!,
    );
    expect(meta.referenceFrame).toBe('J2000');
    expect(meta.timeSystem).toBe('UTC');
    expect(meta.stateCount).toBeGreaterThan(1000);
  }, 120_000);

  it('parses Starlink ephemeris into physically plausible SI states', () => {
    const states = decodeStatesFrame(statesFrame);
    expect(states.length).toBeGreaterThan(1000);
    const s = states[0]!;
    const r = Math.hypot(...s.positionMeters);
    const v = Math.hypot(...s.velocityMetersPerSecond);
    const altKm = (r - RE) / 1000;
    expect(altKm).toBeGreaterThan(200);
    expect(altKm).toBeLessThan(1200); // Starlink LEO shell
    expect(v).toBeGreaterThan(7000);
    expect(v).toBeLessThan(8000);
    // epochs strictly increasing
    for (let i = 1; i < states.length; i++) {
      expect(states[i]!.epoch).toBeGreaterThan(states[i - 1]!.epoch);
    }
  });

  it('validates a clean ephemeris as ok', async () => {
    const validator = registry.byKind('validator')[0]!;
    const frames = await validator.module.invoke(validator.descriptor.methodId, [
      { portId: PORT.STATES, payload: statesFrame },
    ]);
    const result = decodeJsonFrame<{ ok: boolean; confidence: number; issues: unknown[] }>(
      groupByPort(frames).get('result')![0]!,
    );
    expect(result.ok).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.99);
    expect(result.issues).toHaveLength(0);
  });

  it('interpolates exactly at a node epoch (both schemes)', async () => {
    const states = decodeStatesFrame(statesFrame);
    const node = states[100]!;
    for (const scheme of ['hermite', 'lagrange'] as const) {
      const [got] = await interpolateStates(registry, scheme, statesFrame, [node.epoch], 8);
      expect(got!.positionMeters[0]).toBeCloseTo(node.positionMeters[0], 1);
      expect(got!.positionMeters[1]).toBeCloseTo(node.positionMeters[1], 1);
      expect(got!.velocityMetersPerSecond[2]).toBeCloseTo(node.velocityMetersPerSecond[2], 3);
    }
  });

  it('hermite and lagrange agree mid-interval to < 5 m', async () => {
    const states = decodeStatesFrame(statesFrame);
    const t = (states[100]!.epoch + states[101]!.epoch) / 2;
    const [h] = await interpolateStates(registry, 'hermite', statesFrame, [t], 8);
    const [l] = await interpolateStates(registry, 'lagrange', statesFrame, [t], 8);
    const d = Math.hypot(
      h!.positionMeters[0] - l!.positionMeters[0],
      h!.positionMeters[1] - l!.positionMeters[1],
      h!.positionMeters[2] - l!.positionMeters[2],
    );
    expect(d).toBeLessThan(5);
  });

  it('exports CSV with a header row', async () => {
    const exporter = registry.provider('exporter', 'csv')!;
    const frames = await exporter.module.invoke(exporter.descriptor.methodId, [
      { portId: PORT.STATES, payload: statesFrame },
    ]);
    const csv = new TextDecoder().decode(groupByPort(frames).get(PORT.OUT)![0]!);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('epoch_unix_s');
    expect(lines.length).toBeGreaterThan(1000);
  });
});
