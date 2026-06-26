/** YAML configuration (validated with zod) plus defaults. */
import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { DEFAULT_DATA_DIR } from './paths.js';

const SourceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Cap on discovered resources per refresh (null = all). */
  limit: z.number().int().positive().nullable().default(null),
  timeoutMs: z.number().int().positive().default(60_000),
  /** Retries after the first attempt (>= 5 per requirements). */
  retryCount: z.number().int().min(5).default(5),
  /** Requests/second to this source's host (0 = unlimited). */
  rateLimitPerSec: z.number().min(0).default(0),
  /** Scheduled polling interval in seconds (0 = manual only). */
  pollIntervalSec: z.number().min(0).default(0),
});
export type SourceConfig = z.infer<typeof SourceConfigSchema>;

const ConfigSchema = z.object({
  dataDir: z.string().default(DEFAULT_DATA_DIR),
  concurrency: z.number().int().positive().default(8),
  storage: z
    .object({ adapter: z.enum(['flatsql', 'postgres']).default('flatsql') })
    .default({ adapter: 'flatsql' }),
  interpolation: z
    .object({
      defaultInterpolator: z.string().default('bspline'),
      defaultOrder: z.number().int().positive().default(8),
    })
    .default({ defaultInterpolator: 'bspline', defaultOrder: 8 }),
  sources: z.record(SourceConfigSchema).default({}),
});
export type Config = z.infer<typeof ConfigSchema>;

export function defaultSourceConfig(): SourceConfig {
  return SourceConfigSchema.parse({});
}

export function loadConfig(path?: string): Config {
  if (path && existsSync(path)) {
    const raw = parseYaml(readFileSync(path, 'utf8')) as unknown;
    return ConfigSchema.parse(raw ?? {});
  }
  return ConfigSchema.parse({});
}

/** Resolve the effective config for a source (defaults + overrides). */
export function sourceConfig(config: Config, sourceId: string): SourceConfig {
  return config.sources[sourceId] ?? defaultSourceConfig();
}
