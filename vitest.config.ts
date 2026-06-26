import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * The source uses NodeNext-style explicit `.js` import specifiers. This plugin
 * lets Vitest resolve those to the corresponding `.ts` source during tests.
 */
export default defineConfig({
  plugins: [
    {
      name: 'resolve-js-to-ts',
      enforce: 'pre',
      resolveId(source: string, importer: string | undefined) {
        if (importer && /^\.\.?\//.test(source) && source.endsWith('.js')) {
          const candidate = resolve(dirname(importer), `${source.slice(0, -3)}.ts`);
          if (existsSync(candidate)) return candidate;
        }
        return null;
      },
    },
  ],
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
