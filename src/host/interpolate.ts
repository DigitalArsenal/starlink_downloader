/**
 * Interpolation via the orbpro-stack B-spline module (foundation/math-bspline).
 *
 * Instead of our own interpolator, we drive the reused SDN module over its `$BSP`
 * FlatBuffer contract: feed a local window of state-vector waypoints, request a
 * dense equally-spaced resample, and read the interpolated position + first
 * derivative (velocity) nearest each query epoch.
 */
import flatbuffers from 'flatbuffers';
import * as BSP from './vendor/sds-bsp/main.js';
import type { TypeRef } from 'space-data-module-sdk/host/isomorphic';
import type { ModuleRegistry } from './modules/registry.js';
import type { StateVector } from './types.js';
import { decodeStatesFrame } from './wire.js';

const BSP_TYPE: TypeRef = {
  schemaName: 'BSP.fbs',
  fileIdentifier: '$BSP',
  rootTypeName: 'BSP',
  wireFormat: 'aligned-binary',
};

function upperBound(epochs: number[], t: number): number {
  let lo = 0;
  let hi = epochs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (epochs[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function encodeBspRequest(window: StateVector[], sampleCount: number, order: number): Uint8Array {
  const t0 = window[0]!.epoch;
  const T = window.map((s) => s.epoch - t0);
  const X1 = window.map((s) => s.positionMeters[0]);
  const X2 = window.map((s) => s.positionMeters[1]);
  const X3 = window.map((s) => s.positionMeters[2]);
  const b = new flatbuffers.Builder(2048);
  const req = new BSP.BSPInterpolationRequestT(
    new BSP.BSPVector3SeriesT(T, X1, X2, X3),
    sampleCount,
    order,
    false, [], false, [], false, [], false, [],
    'ephem',
  );
  BSP.BSP.finishBSPBuffer(b, new BSP.BSPT(req, null).pack(b));
  return b.asUint8Array();
}

/**
 * Interpolate state vectors at the given epochs using the interpolator module
 * tagged `interpolatorTag` (e.g. 'bspline'). `order` is the B-spline order.
 */
export async function interpolateStates(
  registry: ModuleRegistry,
  interpolatorTag: string,
  statesFrame: Uint8Array,
  epochs: number[],
  order: number,
): Promise<StateVector[]> {
  const interp = registry.provider('interpolator', interpolatorTag) ?? registry.provider('interpolator', 'bspline');
  if (!interp) throw new Error(`no interpolator module provides '${interpolatorTag}'`);

  const states = decodeStatesFrame(statesFrame);
  if (states.length < 2) {
    return epochs.map((e) => states[0] ?? { epoch: e, positionMeters: [0, 0, 0], velocityMetersPerSecond: [0, 0, 0] });
  }
  const allEpochs = states.map((s) => s.epoch);

  const out: StateVector[] = [];
  for (const t of epochs) {
    // Local window of waypoints bracketing the query epoch.
    const windowSize = Math.min(Math.max(order + 3, 6), states.length);
    const hi = upperBound(allEpochs, t);
    let start = hi - (windowSize >> 1);
    start = Math.max(0, Math.min(start, states.length - windowSize));
    const window = states.slice(start, start + windowSize);
    const safeOrder = Math.max(3, Math.min(order, windowSize - 1, 6));

    const span = window[window.length - 1]!.epoch - window[0]!.epoch;
    const sampleCount = Math.max(64, Math.min(4096, Math.ceil(span) + 2));
    const payload = encodeBspRequest(window, sampleCount, safeOrder);

    const frames = await interp.module.invoke(interp.descriptor.methodId, [
      { portId: 'request', payload, typeRef: BSP_TYPE },
    ]);
    const frame = frames.find((f) => f.portId === 'result') ?? frames[0];
    if (!frame) throw new Error('interpolator emitted no result');
    const bb = new flatbuffers.ByteBuffer(frame.payload);
    const result = BSP.BSP.getRootAsBSP(bb).INTERPOLATION_RESULT();
    if (!result) throw new Error('interpolator returned no INTERPOLATION_RESULT');
    const samples = result.SAMPLES()!;
    const n = samples.tLength();
    const rel = t - window[0]!.epoch;

    const num = (v: number | null): number => v ?? 0;
    // Find the two samples bracketing `rel` and linear-interp between them.
    let j = 0;
    while (j < n - 1 && num(samples.T(j + 1)) < rel) j++;
    const j2 = Math.min(j + 1, n - 1);
    const t1 = num(samples.T(j));
    const t2 = num(samples.T(j2));
    const w = t2 > t1 ? (rel - t1) / (t2 - t1) : 0;
    const lerp = (a: number | null, b: number | null): number => num(a) + (num(b) - num(a)) * w;

    out.push({
      epoch: t,
      positionMeters: [
        lerp(samples.X1(j), samples.X1(j2)),
        lerp(samples.X2(j), samples.X2(j2)),
        lerp(samples.X3(j), samples.X3(j2)),
      ],
      velocityMetersPerSecond: [
        lerp(result.XD1(j), result.XD1(j2)),
        lerp(result.XD2(j), result.XD2(j2)),
        lerp(result.XD3(j), result.XD3(j2)),
      ],
    });
  }
  return out;
}
