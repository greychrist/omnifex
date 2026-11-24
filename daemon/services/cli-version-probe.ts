// Keyed on the binary's fingerprint (realpath, mtime, size), so an auto-update is noticed without a spawn per lookup.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export interface CliVersionProbeOptions {
  resolveBinary: () => string | null;
  fingerprint?: (binaryPath: string) => string | null;
  run?: (binaryPath: string) => string;
}

function defaultFingerprint(binaryPath: string): string | null {
  try {
    const real = fs.realpathSync(binaryPath);
    const st = fs.statSync(real);
    return `${real}:${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function defaultRun(binaryPath: string): string {
  return execFileSync(binaryPath, ['--version'], { encoding: 'utf8', timeout: 5000 });
}

export function createCliVersionProbe(opts: CliVersionProbeOptions): () => string | null {
  const fingerprint = opts.fingerprint ?? defaultFingerprint;
  const run = opts.run ?? defaultRun;
  let cache: { key: string; version: string | null } | null = null;

  return () => {
    const binaryPath = opts.resolveBinary();
    if (!binaryPath) return null;
    const fp = fingerprint(binaryPath);
    const key = fp === null ? null : `${binaryPath}\0${fp}`;
    if (key !== null && cache?.key === key) return cache.version;

    let version: string | null;
    try {
      version = run(binaryPath).trim() || null;
    } catch {
      version = null;
    }
    cache = key === null ? null : { key, version };
    return version;
  };
}
