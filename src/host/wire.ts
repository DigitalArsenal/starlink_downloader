/**
 * Cross-language wire contract between the TypeScript host and the C++/WASM
 * compute modules.
 *
 * Every compute invocation exchanges two kinds of frames:
 *
 *  - `meta`   : UTF-8 JSON (small) — metadata, see {@link ParserMeta}.
 *  - `states` : a raw little-endian f64 array, 7 doubles per state vector:
 *               [epoch, x, y, z, vx, vy, vz] in SI units (seconds, m, m/s).
 *
 * Keeping the heavy numeric payload as a flat f64 array means the modules need
 * no JSON or FlatBuffer codegen for the hot path — they `memcpy` doubles — while
 * the small metadata travels as JSON for convenience.
 */
import type { StateVector } from './types.js';

export const PORT = {
  /** Raw input bytes for a parser. */
  RAW: 'raw',
  /** JSON metadata frame. */
  META: 'meta',
  /** Raw f64 state array frame. */
  STATES: 'states',
  /** JSON options frame (e.g. interpolation query). */
  OPTIONS: 'options',
  /** Generic output bytes (exporters). */
  OUT: 'out',
} as const;

export const DOUBLES_PER_STATE = 7;
export const BYTES_PER_STATE = DOUBLES_PER_STATE * 8;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

/** Encode an array of {@link StateVector} to the raw f64 `states` frame. */
export function encodeStatesFrame(states: readonly StateVector[]): Uint8Array {
  const out = new Float64Array(states.length * DOUBLES_PER_STATE);
  for (let i = 0; i < states.length; i++) {
    const s = states[i]!;
    const o = i * DOUBLES_PER_STATE;
    out[o] = s.epoch;
    out[o + 1] = s.positionMeters[0];
    out[o + 2] = s.positionMeters[1];
    out[o + 3] = s.positionMeters[2];
    out[o + 4] = s.velocityMetersPerSecond[0];
    out[o + 5] = s.velocityMetersPerSecond[1];
    out[o + 6] = s.velocityMetersPerSecond[2];
  }
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/** Decode a raw f64 `states` frame into {@link StateVector}s. */
export function decodeStatesFrame(payload: Uint8Array): StateVector[] {
  if (payload.byteLength % BYTES_PER_STATE !== 0) {
    throw new Error(
      `states frame length ${payload.byteLength} is not a multiple of ${BYTES_PER_STATE}`,
    );
  }
  // Copy to guarantee 8-byte alignment for Float64Array.
  const aligned = new Uint8Array(payload.byteLength);
  aligned.set(payload);
  const view = new Float64Array(aligned.buffer);
  const count = payload.byteLength / BYTES_PER_STATE;
  const states: StateVector[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * DOUBLES_PER_STATE;
    states[i] = {
      epoch: view[o]!,
      positionMeters: [view[o + 1]!, view[o + 2]!, view[o + 3]!],
      velocityMetersPerSecond: [view[o + 4]!, view[o + 5]!, view[o + 6]!],
    };
  }
  return states;
}

/** Encode a JSON object to a UTF-8 frame. */
export function encodeJsonFrame(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

/** Decode a UTF-8 JSON frame. */
export function decodeJsonFrame<T = unknown>(payload: Uint8Array): T {
  return JSON.parse(textDecoder.decode(payload)) as T;
}

/** Decode a UTF-8 text frame. */
export function decodeTextFrame(payload: Uint8Array): string {
  return textDecoder.decode(payload);
}
