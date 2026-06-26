/**
 * WasmEdge invocation environment.
 *
 * WasmEdge's AOT compiler and runtime load `libwasmedge` (and LLVM) via the
 * dynamic loader. macOS `npm`/`npx`/`tsx` strip `DYLD_*` from the environment
 * for security, which breaks WasmEdge's AOT codegen (it silently produces an
 * artifact that falls back to interpretation and logs to stdout). We restore
 * the WasmEdge library directory for every `wasmedge` child we spawn.
 *
 * Override the binary with `EPHEM_WASMEDGE` and the lib dir with
 * `EPHEM_WASMEDGE_LIB`.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export const WASMEDGE_BIN = process.env.EPHEM_WASMEDGE ?? 'wasmedge';

function libDirs(): string[] {
  const candidates = [
    process.env.EPHEM_WASMEDGE_LIB,
    process.env.DYLD_LIBRARY_PATH,
    process.env.LD_LIBRARY_PATH,
    join(homedir(), '.wasmedge', 'lib'),
    '/opt/homebrew/lib',
    '/usr/local/lib',
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const entry of candidates) {
    for (const p of entry.split(':')) {
      if (p && !seen.has(p) && existsSync(p)) {
        seen.add(p);
        dirs.push(p);
      }
    }
  }
  return dirs;
}

/** A process env with the WasmEdge library path restored (DYLD_ and LD_). */
export function wasmEdgeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const dirs = libDirs();
  if (dirs.length > 0) {
    const value = dirs.join(':');
    env.DYLD_LIBRARY_PATH = value;
    env.LD_LIBRARY_PATH = value;
  }
  return env;
}
