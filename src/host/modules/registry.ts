/**
 * Module registry — discovers module descriptors under `src/modules/<id>/`,
 * (re)builds stale artifacts, and exposes loaded modules by kind and id.
 *
 * Adding a new module is purely additive: drop a directory containing
 * `module.json`, `manifest.json`, and a C/C++ source — no host edits needed.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { MODULES_DIR } from '../paths.js';
import { childLogger } from '../logger.js';
import { buildModule, isStale, type ModuleBuildSpec } from './build.js';
import { LoadedModule } from './runner.js';

const log = childLogger({ component: 'registry' });

export const MODULE_KINDS = [
  'parser',
  'validator',
  'normalizer',
  'interpolator',
  'exporter',
  'propagator',
] as const;
export type ModuleKind = (typeof MODULE_KINDS)[number];

const DescriptorSchema = z.object({
  id: z.string(),
  kind: z.enum(MODULE_KINDS),
  methodId: z.string(),
  language: z.enum(['c', 'c++']).default('c++'),
  source: z.string().default('module.cpp'),
  /** Input port ids the method reads. */
  inputs: z.array(z.string()).default([]),
  /** Output port ids the method pushes. */
  outputs: z.array(z.string()).default([]),
  name: z.string().default(''),
  version: z.string().default('0.1.0'),
  pluginFamily: z.string().default('ANALYSIS'),
  /** Free-form capability tags (e.g. source ids a parser handles, or scheme). */
  provides: z.array(z.string()).default([]),
  description: z.string().default(''),
});
export type ModuleDescriptor = z.infer<typeof DescriptorSchema>;

export interface RegisteredModule {
  descriptor: ModuleDescriptor;
  dir: string;
  buildSpec: ModuleBuildSpec;
  module: LoadedModule;
  /** True for reused external (orbpro-stack) modules — not compiled from source here. */
  external?: boolean;
}

export class ModuleRegistry {
  private readonly byId = new Map<string, RegisteredModule>();

  private constructor(private readonly modulesDir: string) {}

  /** Discover all module descriptors (without building). */
  static discover(modulesDir = MODULES_DIR): ModuleRegistry {
    const registry = new ModuleRegistry(modulesDir);
    if (!existsSync(modulesDir)) return registry;
    for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(modulesDir, entry.name);
      const descPath = join(dir, 'module.json');
      if (!existsSync(descPath)) continue;
      const descriptor = DescriptorSchema.parse(
        JSON.parse(readFileSync(descPath, 'utf8')),
      );
      const buildSpec: ModuleBuildSpec = {
        id: descriptor.id,
        language: descriptor.language,
        descriptor,
        sourcePath: join(dir, descriptor.source),
        manifestPath: join(dir, 'dist', 'manifest.json'),
        wasmPath: join(dir, 'dist', 'isomorphic', 'module.wasm'),
        aotPath: join(dir, 'dist', 'isomorphic', 'module.aot.wasm'),
      };
      this.assertExists(buildSpec.sourcePath, descriptor.id, 'source');
      registry.byId.set(descriptor.id, {
        descriptor,
        dir,
        buildSpec,
        module: new LoadedModule(descriptor.id, buildSpec.wasmPath, buildSpec.aotPath),
      });
    }
    return registry;
  }

  private static assertExists(path: string, id: string, what: string): void {
    if (!existsSync(path)) throw new Error(`module '${id}' is missing its ${what}: ${path}`);
  }

  /** Build any stale modules (compiles C++ -> WASM). Skips external modules. */
  async buildAll(force = false): Promise<void> {
    for (const reg of this.byId.values()) {
      if (reg.external) continue;
      if (force || isStale(reg.buildSpec)) {
        await buildModule(reg.buildSpec);
      }
    }
  }

  /** Register reused external (orbpro-stack) modules, AOT-compiled into cacheDir. */
  async loadExternal(cacheDir: string): Promise<void> {
    const { loadExternalModules } = await import('./external.js');
    for (const reg of await loadExternalModules(cacheDir)) {
      this.byId.set(reg.descriptor.id, reg);
    }
  }

  /** Ensure a single module's artifact exists, building if needed. */
  async ensureBuilt(id: string): Promise<void> {
    const reg = this.require(id);
    if (isStale(reg.buildSpec)) await buildModule(reg.buildSpec);
  }

  list(): RegisteredModule[] {
    return [...this.byId.values()];
  }

  byKind(kind: ModuleKind): RegisteredModule[] {
    return this.list().filter((m) => m.descriptor.kind === kind);
  }

  /** Find a module by id, optionally constrained to a kind. */
  find(id: string): RegisteredModule | undefined {
    return this.byId.get(id);
  }

  require(id: string): RegisteredModule {
    const reg = this.byId.get(id);
    if (!reg) throw new Error(`no module registered with id '${id}'`);
    return reg;
  }

  /** Find the first module of a kind that `provides` the given tag. */
  provider(kind: ModuleKind, tag: string): RegisteredModule | undefined {
    return this.byKind(kind).find((m) => m.descriptor.provides.includes(tag));
  }

  /** Build status summary for `list-plugins`. */
  status(): Array<{ id: string; kind: ModuleKind; built: boolean; provides: string[] }> {
    return this.list().map((m) => ({
      id: m.descriptor.id,
      kind: m.descriptor.kind,
      built: m.external
        ? existsSync(m.buildSpec.wasmPath)
        : existsSync(m.buildSpec.aotPath) && !isStale(m.buildSpec),
      provides: m.descriptor.provides,
    }));
  }

  async destroy(): Promise<void> {
    for (const reg of this.byId.values()) await reg.module.destroy();
  }
}


/** Convenience: discover + build local modules, register external ones. */
export async function loadRegistry(opts: { build?: boolean } = {}): Promise<ModuleRegistry> {
  const registry = ModuleRegistry.discover();
  if (opts.build !== false) await registry.buildAll();
  await registry.loadExternal(join(MODULES_DIR, '..', '..', '.external-cache'));
  log.debug({ modules: registry.list().map((m) => m.descriptor.id) }, 'registry ready');
  return registry;
}
