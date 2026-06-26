/** Small shared helpers. */
import { createHash } from 'node:crypto';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Convert Unix seconds (f64) to an ISO-8601 UTC string. */
export function unixToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** Parse an ISO-8601 time to Unix seconds (f64). */
export function isoToUnix(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`invalid ISO time: ${iso}`);
  return t / 1000;
}
