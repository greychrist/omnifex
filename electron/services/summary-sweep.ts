/**
 * Catch-up for session summaries that the close path never delivered.
 *
 * Summaries were only ever generated when a tab closed, fire-and-forget. In
 * remote mode tabs outlive the daemon, so for most sessions the only "close"
 * was the daemon's own shutdown: `stopAll()` started a `claude -p` summary per
 * open tab and `process.exit` killed every one of them a moment later. Each
 * update restart lost a batch, and a session that stayed open across several
 * restarts was attempted and killed every time. Closing a tab worked; nothing
 * else did.
 *
 * So shutdown no longer starts summaries (see `session-close-work.ts`), and
 * this sweep, run from `periodic-work.ts` by whichever process owns periodic
 * work, finds idle transcripts whose summary is missing or older than the
 * transcript and generates them a few at a time.
 *
 * The cheap predicates run first: one `readdir` per project and one `stat` per
 * transcript, then a sidecar read only for files inside the time window.
 * Nothing reads a transcript until it is chosen. All of it is async with
 * bounded fan-out: the walk spans every project of every account, and a sync
 * walk held the daemon's one event loop — every live stream — until it ended.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readSidecarAsync, sidecarPathFor } from './sessions-summary';
import { mapLimit } from './util/map-limit';
import { isSummaryScratchProject } from './sessions/internal-spend';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A transcript untouched this long is treated as finished for now. */
const DEFAULT_IDLE_MS = 10 * MINUTE;
/** Older than this is history, not a missed close — never backfilled. */
const DEFAULT_LOOKBACK_MS = 14 * DAY;
/** Summaries cost a model call each; a backlog drains over several ticks. */
const DEFAULT_MAX_PER_TICK = 2;
/** How much of a transcript's head to scan for the `cwd` it ran in. */
const CWD_PROBE_BYTES = 64 * 1024;
/** Concurrent fs calls per stage; see util/map-limit.ts for why it is bounded. */
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
  /** Every account config dir whose `projects/` holds transcripts. */
  listConfigDirs(): string[];
  /** Session UUIDs open in a tab right now; their transcripts are still growing. */
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
  /** Generate up to `maxPerTick` summaries. Resolves to how many were attempted. */
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

/** The `cwd` recorded on the transcript's first record that carries one. */
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
  // Transcript path -> the size it had when last attempted. An attempt that
  // did not produce a summary (empty session, malformed reply, no model
  // configured) would otherwise be retried every tick, paying each time. The
  // transcript growing is the only thing that makes another attempt worth it.
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
    // Newest first: the session the user just walked away from is the one they
    // are most likely to look for on the project page.
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
