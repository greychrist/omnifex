// Sessions module — TUI cold-start discovery
//
// When starting a TUI session without `--resume`, the CLI mints a new
// sessionId and creates `<configDir>/projects/<encoded-projectPath>/<id>.jsonl`.
// We don't know the id until that file appears. This helper:
//   1. Records the set of existing JSONL filenames in the projects dir.
//   2. Polls every 100ms for new files.
//   3. Resolves with the basename (sessionId) and full path of the new file.
//
// Polling rather than fs.watch — same rationale as jsonl-tail.ts: fs.watch
// is unreliable on macOS, fs.watchFile uses polling under the hood, and our
// cost is one readdir per session-start per 100ms (negligible).

import fs from 'node:fs';
import path from 'node:path';
import { encodeProjectKey } from './summary-query';

export interface DiscoverArgs {
  configDir: string;
  projectPath: string;
  /** Hard ceiling; rejects with a timeout error if no new file appears. */
  timeoutMs?: number;
}

export interface DiscoveryResult {
  sessionId: string;
  jsonlPath: string;
}

const POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 10_000;

export function discoverNewSessionFile(args: DiscoverArgs): Promise<DiscoveryResult> {
  const { configDir, projectPath, timeoutMs = DEFAULT_TIMEOUT_MS } = args;
  const encoded = encodeProjectKey(projectPath);
  const projectsDir = path.join(configDir, 'projects', encoded);

  // Take the baseline BEFORE creating the dir. If the dir doesn't exist yet,
  // listJsonls returns the empty set — which is the correct baseline. Doing
  // mkdir first opens a (tiny) race where the CLI could create both the dir
  // and its first JSONL before our readdir runs, putting the new file in the
  // baseline and making us blind to it.
  const baselineJsonls = listJsonls(projectsDir);
  try { fs.mkdirSync(projectsDir, { recursive: true }); } catch { /* ignore */ }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = setInterval(() => {
      const current = listJsonls(projectsDir);
      const newFile = [...current].find((f) => !baselineJsonls.has(f));
      if (newFile) {
        clearInterval(poll);
        const sessionId = newFile.replace(/\.jsonl$/, '');
        resolve({ sessionId, jsonlPath: path.join(projectsDir, newFile) });
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(poll);
        reject(new Error(`TUI cold-start: timed out waiting for new JSONL in ${projectsDir}`));
      }
    }, POLL_INTERVAL_MS);
  });
}

function listJsonls(dir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')));
  } catch {
    return new Set();
  }
}
