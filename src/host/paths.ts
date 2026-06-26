/** Locate well-known package directories regardless of tsx-vs-built execution. */
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function findPackageRoot(start: string): string {
  let dir = start;
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string };
        if (json.name === 'ephem') return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('could not locate ephem package root');
    dir = parent;
  }
}

/** Absolute path to the package root (the directory holding package.json). */
export const PACKAGE_ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

/** Module sources/manifests/artifacts live here (never compiled by tsc). */
export const MODULES_DIR = join(PACKAGE_ROOT, 'src', 'modules');

/** Path to the SDK CLI entry point. */
export const SDK_CLI = join(
  PACKAGE_ROOT,
  'node_modules',
  'space-data-module-sdk',
  'bin',
  'space-data-module.js',
);

/** Default data directory for the archive (SQLite db + raw files). */
export const DEFAULT_DATA_DIR = join(PACKAGE_ROOT, 'data');
