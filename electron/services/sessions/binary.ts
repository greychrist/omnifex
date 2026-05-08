// Sessions module — Claude binary resolver
//
// Extracted into its own module so tests can mock the resolution result
// without spying on `fs.existsSync` (which has side effects on the rest
// of the test file).

import fs from 'node:fs';
import os from 'node:os';
import { findBundledSdkBinaryAuto } from '../claude-binary';

/**
 * Resolve a claude binary: prefer a system install, fall back to the
 * per-platform binary bundled with the SDK so packaged builds still work
 * for users without Claude Code installed system-wide.
 *
 * Returns `null` when nothing is found. Callers should treat null as
 * fatal at session start — letting the SDK try its own resolution and
 * fail with an opaque spawn error mid-stream is worse UX than a clean
 * "binary not found" message up front.
 */
export function findSystemClaudeBinary(): string | null {
  const candidates = [
    `${os.homedir()}/.local/bin/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return findBundledSdkBinaryAuto();
}
