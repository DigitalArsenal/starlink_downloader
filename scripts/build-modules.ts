/** Compile (and validate) every C++/WASM compute module. */
import { ModuleRegistry } from '../src/host/modules/registry.js';
import { logger } from '../src/host/logger.js';

const force = process.argv.includes('--force');
const registry = ModuleRegistry.discover();
const mods = registry.list();
logger.info({ count: mods.length, modules: mods.map((m) => m.descriptor.id) }, 'building modules');
await registry.buildAll(force);
logger.info('all modules built');
