/** Interpolation helper — drives an interpolator WASM module. */
import type { ModuleRegistry } from './modules/registry.js';
import type { StateVector } from './types.js';
import { decodeStatesFrame, PORT } from './wire.js';

function encodeQuery(order: number, epochs: number[]): Uint8Array {
  const arr = new Float64Array(1 + epochs.length);
  arr[0] = order;
  for (let i = 0; i < epochs.length; i++) arr[i + 1] = epochs[i]!;
  return new Uint8Array(arr.buffer);
}

/**
 * Interpolate state vectors at the given epochs using the interpolator module
 * tagged `interpolatorTag` (e.g. 'lagrange', 'hermite').
 */
export async function interpolateStates(
  registry: ModuleRegistry,
  interpolatorTag: string,
  statesFrame: Uint8Array,
  epochs: number[],
  order: number,
): Promise<StateVector[]> {
  const interp = registry.provider('interpolator', interpolatorTag);
  if (!interp) throw new Error(`no interpolator module provides '${interpolatorTag}'`);
  const frames = await interp.module.invoke(interp.descriptor.methodId, [
    { portId: PORT.STATES, payload: statesFrame },
    { portId: 'query', payload: encodeQuery(order, epochs) },
  ]);
  const out = frames.find((f) => f.portId === PORT.STATES);
  if (!out) throw new Error('interpolator emitted no states');
  return decodeStatesFrame(out.payload);
}
