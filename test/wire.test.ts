import { describe, it, expect } from 'vitest';
import {
  encodeStatesFrame,
  decodeStatesFrame,
  encodeJsonFrame,
  decodeJsonFrame,
  BYTES_PER_STATE,
} from '../src/host/wire.js';
import type { StateVector } from '../src/host/types.js';

const sample: StateVector[] = [
  { epoch: 1000, positionMeters: [1, 2, 3], velocityMetersPerSecond: [4, 5, 6] },
  { epoch: 1060, positionMeters: [7, 8, 9], velocityMetersPerSecond: [10, 11, 12] },
];

describe('wire contract', () => {
  it('round-trips state vectors through the f64 frame', () => {
    const frame = encodeStatesFrame(sample);
    expect(frame.byteLength).toBe(sample.length * BYTES_PER_STATE);
    const back = decodeStatesFrame(frame);
    expect(back).toEqual(sample);
  });

  it('rejects mis-sized states frames', () => {
    expect(() => decodeStatesFrame(new Uint8Array(10))).toThrow();
  });

  it('round-trips JSON frames', () => {
    const frame = encodeJsonFrame({ a: 1, b: 'x' });
    expect(decodeJsonFrame(frame)).toEqual({ a: 1, b: 'x' });
  });
});
