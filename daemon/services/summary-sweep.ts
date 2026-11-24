// Shutdown never starts summaries (process.exit killed them), so this sweep catches up.
// Async with bounded fan-out: the walk spans every project of every account, on the daemon's one event loop.

import fs from 'node:fs';
import path from 'node:path';
import { readSidecarAsync, sidecarPathFor } from './sessions-summary';
import { mapLimit } from './util/map-limit';
import { isSummaryScratchProject } from './sessions/internal-spend';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const DEFAULT_IDLE_MS = 10 * MINUTE;
const DEFAULT_LOOKBACK_MS = 14 * DAY;
const DEFAULT_MAX_PER_TICK = 2;
const CWD_PROBE_BYTES = 64 * 1024;
const FS_CONCURRENCY = 8;
const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

interface SummaryLike {
  generateSummary(
    sessionUuid: string,
    projectPath: string,
    configDir: string,
  ): Promise<unknown>;
}

export interface SummarySweepDeps {
  listConfigDirs(): string[];
  activeSessionIds(): string[];
  /** Read per tick: both roots assign the summary service after construction. */
  summary(): SummaryLike | null | undefined;
  log: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  now?: () => number;
  idleMs?: number;
  lookbackMs?: number;
  maxPerTick?: number;
}

export interface SummarySweep {
  tick(): Promise<number>;
}

interface Candidate {
  uuid: string;
  file: string;
  configDir: string;
  size: number;
  mtimeMs: number;
}

async function listDir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readCwd(file: string): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(CWD_PROBE_BYTES);
    const { bytesRead: n } = await handle.read(buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      if (!line.includes('"cwd"')) continue;
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
        if (typeof cwd === 'string' && cwd) return cwd;
      } catch {
        // A line cut off by the probe window, or not JSON — keep looking.
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

export function createSummarySweep(deps: SummarySweepDeps): SummarySweep {
  const now = deps.now ?? Date.now;
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  const lookbackMs = deps.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const maxPerTick = deps.maxPerTick ?? DEFAULT_MAX_PER_TICK;
  // Size at the last attempt: a failed attempt would otherwise retry, and pay, every tick.
  const attempted = new Map<string, number>();

  async function candidates(): Promise<Candidate[]> {
    const t = now();
    const active = new Set(deps.activeSessionIds());
    const projectDirs: { configDir: string; projectDir: string }[] = [];
    for (const configDir of deps.listConfigDirs()) {
      const projectsDir = path.join(configDir, 'projects');
      for (const project of await listDir(projectsDir)) {
        if (!project.isDirectory() || isSummaryScratchProject(project.name)) continue;
        projectDirs.push({ configDir, projectDir: path.join(projectsDir, project.name) });
      }
    }
    const listings = await mapLimit(projectDirs, FS_CONCURRENCY, async ({ configDir, projectDir }) => {
      const files: { uuid: string; file: string; configDir: string }[] = [];
      for (const entry of await listDir(projectDir)) {
        if (!entry.isFile() || !UUID_JSONL.test(entry.name)) continue;
        const uuid = entry.name.slice(0, -'.jsonl'.length);
        if (active.has(uuid)) continue;
        files.push({ uuid, file: path.join(projectDir, entry.name), configDir });
      }
      return files;
    });
    const checked = await mapLimit(listings.flat(), FS_CONCURRENCY, async ({ uuid, file, configDir }) => {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(file);
      } catch {
        return null;
      }
      const age = t - stat.mtimeMs;
      if (age < idleMs || age > lookbackMs) return null;
      if (attempted.get(file) === stat.size) return null;
      if ((await readSidecarAsync(sidecarPathFor(file)))?.jsonlSize === stat.size) return null;
      return { uuid, file, configDir, size: stat.size, mtimeMs: stat.mtimeMs };
    });
    const out = checked.filter((c): c is Candidate => c !== null);
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  async function tick(): Promise<number> {
    const summary = deps.summary();
    if (!summary) return 0;
    let done = 0;
    for (const c of await candidates()) {
      if (done >= maxPerTick) break;
      const projectPath = await readCwd(c.file);
      attempted.set(c.file, c.size);
      if (!projectPath) continue;
      done++;
      try {
        const result = await summary.generateSummary(c.uuid, projectPath, c.configDir);
        deps.log.info('summary sweep', {
          sessionId: c.uuid,
          status: (result as { status?: unknown } | null)?.status ?? null,
        });
      } catch (err) {
        deps.log.warn('summary sweep generation failed', { sessionId: c.uuid, error: String(err) });
      }
    }
    return done;
  }

  return { tick };
}
