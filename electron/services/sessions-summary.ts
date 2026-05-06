import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const CURRENT_SCHEMA_VERSION = 1;

export interface SessionSummary {
  version: number;
  headline: string;
  paragraph: string;
  messageCount: number;
  jsonlSize: number;
  generatedAt: string;
  model: string;
  accountName: string;
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Sidecar I/O
// ---------------------------------------------------------------------------

/** Path of the sidecar that lives next to a session JSONL. */
export function sidecarPathFor(jsonlPath: string): string {
  return jsonlPath.replace(/\.jsonl$/, '.summary.json');
}

/**
 * Read a sidecar from disk. Returns null on any failure (missing file,
 * unreadable, corrupt JSON, schema version mismatch). The renderer treats
 * null as "no summary yet" and falls through to the first-message preview.
 */
export function readSidecar(sidecarPath: string): SessionSummary | null {
  let raw: string;
  try {
    raw = fs.readFileSync(sidecarPath, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { version?: unknown }).version !== CURRENT_SCHEMA_VERSION
  ) {
    return null;
  }
  return parsed as SessionSummary;
}

/**
 * Write a sidecar atomically: write to <path>.tmp, then rename. A crash
 * mid-write can never leave a partially-written sidecar.
 */
export function writeSidecar(sidecarPath: string, summary: SessionSummary): void {
  const tmpPath = sidecarPath + '.tmp';
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(summary, null, 2), 'utf-8');
  fs.renameSync(tmpPath, sidecarPath);
}
