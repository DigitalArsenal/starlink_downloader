/**
 * Build helper: generate a module's strict SDK manifest from its descriptor,
 * compile its C++ source to an isomorphic WASM artifact via the SDK CLI
 * (`space-data-module compile`), and validate it (`check`).
 *
 * The CLI is used (rather than the programmatic API) so the build path is
 * byte-for-byte the same one documented for end users.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SDK_CLI } from '../paths.js';
import { childLogger } from '../logger.js';
import { generateManifest } from './manifest.js';
import { WASMEDGE_BIN, wasmEdgeEnv } from '../wasmedge.js';
import type { ModuleDescriptor } from './registry.js';

const execFileAsync = promisify(execFile);
const log = childLogger({ component: 'module-build' });

export interface ModuleBuildSpec {
  id: string;
  language: 'c' | 'c++';
  descriptor: ModuleDescriptor;
  sourcePath: string;
  /** Generated manifest path (written by {@link buildModule}). */
  manifestPath: string;
  wasmPath: string;
  /** AOT-compiled artifact path (WasmEdge), the fast runtime path. */
  aotPath: string;
}

/** True when the AOT artifact is missing or older than its source. */
export function isStale(spec: ModuleBuildSpec): boolean {
  if (!existsSync(spec.aotPath)) return true;
  const aotMtime = statSync(spec.aotPath).mtimeMs;
  return existsSync(spec.sourcePath) && statSync(spec.sourcePath).mtimeMs > aotMtime;
}

/** Compile (and validate) a single module. Returns the wasm path. */
export async function buildModule(spec: ModuleBuildSpec): Promise<string> {
  mkdirSync(dirname(spec.manifestPath), { recursive: true });
  mkdirSync(dirname(spec.wasmPath), { recursive: true });
  writeFileSync(spec.manifestPath, JSON.stringify(generateManifest(spec.descriptor), null, 2));

  log.info({ module: spec.id }, 'compiling module');
  await execFileAsync('node', [
    SDK_CLI,
    'compile',
    '--manifest',
    spec.manifestPath,
    '--source',
    spec.sourcePath,
    '--out',
    spec.wasmPath,
    '--language',
    spec.language,
  ]);

  const { stdout } = await execFileAsync('node', [
    SDK_CLI,
    'check',
    '--manifest',
    spec.manifestPath,
    '--wasm',
    spec.wasmPath,
    '--json',
  ]);
  const report = JSON.parse(stdout) as {
    ok: boolean;
    issues: Array<{ severity: string; code: string; message: string }>;
  };
  const errors = report.issues.filter((i) => i.severity === 'error');
  if (!report.ok || errors.length > 0) {
    throw new Error(
      `module '${spec.id}' failed validation: ${errors.map((e) => `${e.code} ${e.message}`).join('; ')}`,
    );
  }

  // AOT-compile with WasmEdge — turns ~19s interpreted invokes into ~0.2s.
  // The restored DYLD/LD library path is essential: without it WasmEdge's AOT
  // codegen silently degrades to a broken, interpreted artifact.
  log.info({ module: spec.id }, 'AOT compiling (wasmedge)');
  await execFileAsync(WASMEDGE_BIN, ['compile', spec.wasmPath, spec.aotPath], {
    env: wasmEdgeEnv(),
  });

  log.info({ module: spec.id }, 'module built + validated + AOT compiled');
  return spec.aotPath;
}
