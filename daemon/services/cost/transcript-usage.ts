// Never read a transcript synchronously: one event loop runs every live session.

import fs from 'node:fs';
import path from 'node:path';
import { foldUsage, newUsageFold, type UsageFold } from './usage-extract';

export interface CostFs {
  readRange(p: string, start: number, end: number): Promise<Buffer | null>;
  listDir(p: string): MaybePromise<{ name: string; isDirectory: boolean }[]>;
  stat(p: string): MaybePromise<FileStat | null>;
}

type MaybePromise<T> = T | Promise<T>;

export interface FileStat {
  size: number;
  mtimeMs: number;
}

export interface FileUsageState {
  size: number;
  mtimeMs: number;
  offset: number;
  fold: UsageFold;
}

export const READ_CHUNK_BYTES = 4 * 1024 * 1024;

/** On null, `prev` must not be reused; the caller starts over. */
export async function advanceFileUsage(
  fsDeps: CostFs,
  filePath: string,
  stat: FileStat,
  prev?: FileUsageState,
): Promise<{ state: FileUsageState; changed: boolean } | null> {
  if (prev?.size === stat.size && prev.mtimeMs === stat.mtimeMs) return { state: prev, changed: false };
  const state: FileUsageState =
    prev && stat.size > prev.size ? prev : { size: 0, mtimeMs: 0, offset: 0, fold: newUsageFold() };

  // `carry` may be a line the CLI is still writing.
  let pos = state.offset;
  let carry: Buffer = Buffer.alloc(0);
  while (pos < stat.size) {
    const buf = await fsDeps.readRange(filePath, pos, Math.min(stat.size, pos + READ_CHUNK_BYTES));
    if (buf === null) return null;
    if (buf.length === 0) break;
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
  state.size = pos;
  state.mtimeMs = stat.mtimeMs;
  return { state, changed: true };
}

/** Workflow agents sit at depth 3; the cap stops a symlink loop. */
const MAX_SUBAGENT_DEPTH = 6;

/** Recursive: Workflow subagents nest under `subagents/workflows/wf_<id>/`, and a flat listing drops them. Sorted for stable signatures. */
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
