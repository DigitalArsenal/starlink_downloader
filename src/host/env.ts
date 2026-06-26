/**
 * Loads credentials from a `.env` file at the package root (without overriding
 * real environment variables) and exposes typed accessors. `.env` is
 * git-ignored; see `.env.example` for the template.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from './paths.js';

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv(join(PACKAGE_ROOT, '.env'));

export interface SpaceTrackCredentials {
  identity: string;
  password: string;
  /** Base URL (override for testing/mirrors). */
  baseUrl: string;
}

export interface SpireCredentials {
  apiKey: string;
  baseUrl: string;
}

export interface VimpelCredentials {
  identity: string;
  password: string;
  /** HTTP-only base URL (the portal's HTTPS cert is dead). */
  baseUrl: string;
}

/** Space-Track login, or null if not configured. */
export function spaceTrackCredentials(): SpaceTrackCredentials | null {
  const identity = process.env.SPACETRACK_IDENTITY?.trim();
  const password = process.env.SPACETRACK_PASSWORD?.trim();
  if (!identity || !password) return null;
  return {
    identity,
    password,
    baseUrl: process.env.SPACETRACK_BASE_URL?.trim() || 'https://www.space-track.org',
  };
}

/** Spire Global orbit API key, or null if not configured. */
export function spireCredentials(): SpireCredentials | null {
  const apiKey = process.env.SPIRE_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: process.env.SPIRE_BASE_URL?.trim() || 'https://api.orb.spire.com',
  };
}

/** JSC Vimpel portal login, or null if not configured. */
export function vimpelCredentials(): VimpelCredentials | null {
  const identity = process.env.VIMPEL_IDENTITY?.trim();
  const password = process.env.VIMPEL_PASSWORD?.trim();
  if (!identity || !password) return null;
  return {
    identity,
    password,
    baseUrl: process.env.VIMPEL_BASE_URL?.trim() || 'http://spacedata.vimpel.ru',
  };
}
