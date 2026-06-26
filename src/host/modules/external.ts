/**
 * External SDN modules reused from orbpro-stack (instead of building our own
 * interpolator/propagator). Their prebuilt `dist/isomorphic/module.wasm` is
 * AOT-compiled into a local cache and invoked via the same PIV runner. Requires
 * the SDK aligned to orbpro-stack's version ($PIV envelope) — see README.
 *
 * Override the modules directory with `ORBPRO_MODULES_DIR`.
 */
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { PACKAGE_ROOT } from '../paths.js';
import { aotCompile } from './build.js';
import { LoadedModule } from './runner.js';
import type { ModuleDescriptor, ModuleKind, RegisteredModule } from './registry.js';
import { childLogger } from '../logger.js';

const log = childLogger({ component: 'external-modules' });

const ORBPRO_MODULES_DIR =
  process.env.ORBPRO_MODULES_DIR ??
  join(
    dirname(PACKAGE_ROOT),
    'orbpro-stack/repos/main-packages/OrbPro/packages/space-data-network-modules',
  );

interface ExternalSpec {
  id: string;
  kind: ModuleKind;
  methodId: string;
  provides: string[];
  name: string;
  description: string;
  relWasm: string;
}

const SPECS: ExternalSpec[] = [
  {
    id: 'orbpro-bspline',
    kind: 'interpolator',
    methodId: 'interpolate_bspline',
    provides: ['bspline', 'default'],
    name: 'B-spline Interpolator (orbpro-stack math-bspline)',
    description: 'orbpro-stack foundation/math-bspline — B-spline position+velocity interpolation ($BSP).',
    relWasm: 'foundation/math-bspline/dist/isomorphic/module.wasm',
  },
  {
    id: 'orbpro-numerics',
    kind: 'interpolator',
    methodId: 'interpolate_scalar',
    provides: ['linear'],
    name: 'Numerics scalar interpolator (orbpro-stack numerics)',
    description: 'orbpro-stack foundation/numerics — linear/bilinear scalar interpolation ($NUM).',
    relWasm: 'foundation/numerics/dist/isomorphic/module.wasm',
  },
  {
    id: 'orbpro-sgp4',
    kind: 'propagator',
    methodId: 'propagate_state',
    provides: ['sgp4', 'omm', 'tle'],
    name: 'SGP4/SDP4 Propagator (orbpro-stack sgp4)',
    description: 'orbpro-stack propagator/sgp4 — ingest OMM/TLE and propagate to PropagatorState (TEME, m, m/s).',
    relWasm: 'propagator/sgp4/dist/isomorphic/module.wasm',
  },
];

function descriptorFor(s: ExternalSpec, wasm: string, aot: string): RegisteredModule {
  const descriptor: ModuleDescriptor = {
    id: s.id,
    kind: s.kind,
    methodId: s.methodId,
    language: 'c++',
    source: '',
    inputs: [],
    outputs: [],
    name: s.name,
    version: '0.1.0',
    pluginFamily: 'foundation',
    provides: s.provides,
    description: s.description,
  };
  return {
    descriptor,
    dir: dirname(wasm),
    buildSpec: { id: s.id, language: 'c++', descriptor, sourcePath: wasm, manifestPath: '', wasmPath: wasm, aotPath: aot },
    module: new LoadedModule(s.id, wasm, aot),
    external: true,
  };
}

/** Discover + AOT-compile the external orbpro-stack modules. */
export async function loadExternalModules(cacheDir: string): Promise<RegisteredModule[]> {
  const out: RegisteredModule[] = [];
  for (const s of SPECS) {
    const wasm = join(ORBPRO_MODULES_DIR, s.relWasm);
    if (!existsSync(wasm)) {
      log.warn({ id: s.id, wasm }, 'external orbpro module not found — skipping (build it in orbpro-stack)');
      continue;
    }
    const aot = join(cacheDir, `${s.id}.aot.wasm`);
    try {
      await aotCompile(wasm, aot);
    } catch (err) {
      log.warn({ id: s.id, err: String(err) }, 'external module AOT failed — will run interpreted');
    }
    out.push(descriptorFor(s, wasm, aot));
    log.debug({ id: s.id }, 'external module registered');
  }
  return out;
}
