// Cost module — reading a transcript's usage without stalling the daemon.
//
// The daemon runs every live session on one event loop, so a transcript is
// never read in one synchronous gulp: reads go through the thread pool in
// bounded chunks, and each chunk is parsed before the next is read, so no
// single parse holds the loop for more than one chunk's worth of lines. And a
// reader that keeps its state can continue where it stopped: a grown file
// costs only its appended bytes.

import fs from 'node:fs';
import path from 'node:path';
import { foldUsage, newUsageFold, type UsageFold } from './usage-extract';

/** The filesystem the cost module reads through. Async, so nothing it does
 *  blocks the event loop; injectable, so tests need no disk. */
export interface CostFs {
  /** Bytes `[start, end)` of a file, fewer if it is shorter; null if unreadable. */
  readRange(p: string, start: number, end: number): Promise<Buffer | null>;
  listDir(p: string): MaybePromise<{ name: string; isDirectory: boolean }[]>;
  stat(p: string): MaybePromise<FileStat | null>;
}

type MaybePromise<T> = T | Promise<T>;

export interface FileStat {
  size: number;
  mtimeMs: number;
}

/** One transcript folded up to `offset`, the byte just past its last complete line. */
export interface FileUsageState {
  size: number;
  mtimeMs: number;
  offset: number;
  fold: UsageFold;
}

/** Parse at most this much per turn of the event loop. 4 MiB of JSONL is
 *  roughly 10-20 ms of JSON.parse. */
export const READ_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Bring `prev` up to date with the file as `stat` describes it. Unchanged
 * (same size and mtime): `prev` itself, nothing read. Grown: only the new
 * bytes. Smaller, or the same size with a new mtime: rewritten, so read from
 * the start. Mutates and returns `prev` when appending; on a failed read
 * returns null, and `prev` must not be reused — the caller starts over.
 */
export async function advanceFileUsage(
  fsDeps: CostFs,
  filePath: string,
  stat: FileStat,
  prev?: FileUsageState,
): Promise<{ state: FileUsageState; changed: boolean } | null> {
  if (prev?.size === stat.size && prev.mtimeMs === stat.mtimeMs) return { state: prev, changed: false };
  const state: FileUsageState =
    prev && stat.size > prev.size ? prev : { size: 0, mtimeMs: 0, offset: 0, fold: newUsageFold() };

  // `carry` holds the bytes after the last newline seen so far: a line split
  // across chunks, or the partial line the CLI is still writing.
  let pos = state.offset;
  let carry: Buffer = Buffer.alloc(0);
  while (pos < stat.size) {
    const buf = await fsDeps.readRange(filePath, pos, Math.min(stat.size, pos + READ_CHUNK_BYTES));
    if (buf === null) return null;
    if (buf.length === 0) break; // shrank since the stat; the next look sees it
    pos += buf.length;
    const data = carry.length > 0 ? Buffer.concat([carry, buf]) : buf;
    const nl = data.lastIndexOf(0x0a);
    if (nl < 0) {
      carry = data;
      continue;
    }
    foldUsage(state.fold, data.toString('utf8', 0, nl), { tailIsPartial: false });
    state.offset += nl + 1;
    carry = data.subarray(nl + 1);
  }
  if (carry.length > 0) foldUsage(state.fold, carry.toString('utf8'), { tailIsPartial: true });
  // What was actually seen: a file that was cut short under the read reports
  // a different size next time and is looked at again.
  state.size = pos;
  state.mtimeMs = stat.mtimeMs;
  return { state, changed: true };
}

/** Depth cap for the subagents walk. Workflow agents sit at
 *  `subagents/workflows/<wf-id>/agent-*.jsonl` — depth 3 — so 6 leaves room
 *  for another nesting level upstream without letting a symlink loop spin. */
const MAX_SUBAGENT_DEPTH = 6;

/**
 * Every subagent transcript for one session, at any depth under `subagents/`.
 *
 * The CLI writes plain Task subagents flat (`subagents/agent-<id>.jsonl`) but
 * Workflow subagents one directory deeper
 * (`subagents/workflows/wf_<id>/agent-<id>.jsonl`). A non-recursive listing
 * sees only the first kind and silently drops the rest — for 2026-08 on
 * ~/.claude-work that was 16 files and $37.41 of real spend. See
 * docs/superpowers/specs/2026-08-26-cost-report-page-design.md §1.1.
 *
 * Returns absolute paths, sorted, so callers get a stable order for both
 * change-detection signatures and cost aggregation.
 */
export async function collectSubagentFiles(fsDeps: CostFs, subagentsDir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_SUBAGENT_DEPTH) return;
    for (const entry of await fsDeps.listDir(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(full, depth + 1);
      } else if (entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl')) {
        found.push(full);
      }
    }
  };
  await walk(subagentsDir, 0);
  return found.sort();
}

/** The agent id a subagent transcript's name carries (`agent-<id>.jsonl`). */
export function subagentId(filePath: string): string {
  return path.basename(filePath).slice('agent-'.length, -'.jsonl'.length);
}

export const nodeCostFs: CostFs = {
  async readRange(p, start, end) {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(p, 'r');
      const buf = Buffer.alloc(Math.max(0, end - start));
      let read = 0;
      while (read < buf.length) {
        const { bytesRead } = await handle.read(buf, read, buf.length - read, start + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return read === buf.length ? buf : buf.subarray(0, read);
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  },
  async listDir(p) {
    try {
      const entries = await fs.promises.readdir(p, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    } catch {
      return [];
    }
  },
  async stat(p) {
    try {
      const s = await fs.promises.stat(p);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return null;
    }
  },
};
