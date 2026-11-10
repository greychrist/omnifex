// `claude --version`, re-checked on every lookup.
//
// The model and slash-command catalogs are invalidated when the CLI version
// changes. The version used to be probed once per service lifetime — i.e.
// once per daemon — so a CLI that auto-updated under a long-running daemon
// kept serving the old version's catalog until the 24 h TTL or a restart.
//
// Spawning `--version` on every lookup would be a synchronous process launch
// per picker open, so the probe is keyed on a cheap fingerprint of the
// binary instead: its realpath (the native installer swaps a symlink to
// `versions/<x>`) plus mtime and size (npm installs rewrite in place). The
// spawn runs only when that fingerprint changes.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export interface CliVersionProbeOptions {
  resolveBinary: () => string | null;
  /** Identity of the binary on disk; null when it cannot be read. */
  fingerprint?: (binaryPath: string) => string | null;
  /** Runs `<binary> --version` and returns stdout. */
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

/** Returns a function answering the current CLI version, or null when undeterminable. */
export function createCliVersionProbe(opts: CliVersionProbeOptions): () => string | null {
  const fingerprint = opts.fingerprint ?? defaultFingerprint;
  const run = opts.run ?? defaultRun;
  let cache: { key: string; version: string | null } | null = null;

  return () => {
    const binaryPath = opts.resolveBinary();
    if (!binaryPath) return null;
    const fp = fingerprint(binaryPath);
    // No fingerprint → nothing to key a cache on; probe every time.
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
