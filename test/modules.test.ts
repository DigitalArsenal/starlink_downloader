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
    await registry.loadExternal(join(PACKAGE_ROOT, '.external-cache')); // orbpro modules (if present)
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

  // Interpolation is delegated to the reused orbpro-stack math-bspline module.
  // Skips when orbpro-stack isn't present (no external interpolator registered).
  it('interpolates a node accurately via orbpro math-bspline', async () => {
    if (!registry.provider('interpolator', 'bspline')) {
      console.warn('orbpro-stack math-bspline not available — skipping interpolation test');
      return;
    }
    const states = decodeStatesFrame(statesFrame);
    const node = states[100]!;
    const [got] = await interpolateStates(registry, 'bspline', statesFrame, [node.epoch], 8);
    const dp = Math.hypot(
      got!.positionMeters[0] - node.positionMeters[0],
      got!.positionMeters[1] - node.positionMeters[1],
      got!.positionMeters[2] - node.positionMeters[2],
    );
    const dv = Math.hypot(
      got!.velocityMetersPerSecond[0] - node.velocityMetersPerSecond[0],
      got!.velocityMetersPerSecond[1] - node.velocityMetersPerSecond[1],
      got!.velocityMetersPerSecond[2] - node.velocityMetersPerSecond[2],
    );
    expect(dp).toBeLessThan(50); // metres
    expect(dv).toBeLessThan(0.1); // m/s
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
