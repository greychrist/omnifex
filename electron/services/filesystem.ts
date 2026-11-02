/**
 * Filesystem service — powers the FilePicker's `@`-mention navigation and
 * the Projects page's New Project folder creation.
 *
 * Pure I/O with no account / config coupling:
 *
 *   - `listDirectoryContents(path)` returns one level of entries, sorted
 *     directories first then files (alpha within each group), with
 *     dot-prefixed names hidden by default.
 *   - `searchFiles(basePath, query)` walks `basePath` recursively, returning
 *     entries whose name contains `query` (case-insensitive). Dot-prefixed
 *     directories are skipped so we don't descend into `.git/` or
 *     `node_modules`-adjacent hidden trees. Results are capped so deep
 *     monorepos can't produce runaway responses.
 *   - `createDirectory(path)` makes one new folder. An existing folder is
 *     returned as-is — the save dialog behind New Project offers "Replace?"
 *     for one, and a retry after a cancelled account picker names the folder
 *     the first try made; both mean "open it". An existing file is refused,
 *     and missing parents are never created, so a mistyped path fails loudly.
 *   - `saveDroppedFile(name, base64)` keeps a copy of a file dropped onto the
 *     chat that has no path of its own (dragged from a browser, the iPad) and
 *     returns where it went, for the prompt to `@`-mention. One folder per
 *     drop so equal names never collide; drops past the retention window are
 *     deleted on the next save rather than by a timer. The dir is the
 *     tmpdir's realpath: the CLI matches permission rules on resolved paths,
 *     and macOS's tmpdir is a `/var` symlink.
 *
 * All three throw a regular `Error` on malformed input — the IPC
 * wrap-and-repackage layer in `electron/ipc/handlers.ts` will surface
 * `error.message` to the renderer.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
  size: number;
  extension?: string;
}

export interface FilesystemService {
  listDirectoryContents(directoryPath: string): Promise<FileEntry[]>;
  searchFiles(basePath: string, query: string): Promise<FileEntry[]>;
  createDirectory(directoryPath: string): Promise<string>;
  saveDroppedFile(name: string, base64: string): Promise<string>;
}

export interface FilesystemServiceOptions {
  /** Cap on entries returned by `searchFiles`. */
  maxResults?: number;
  /** Cap on directory-tree depth searched by `searchFiles`. */
  maxDepth?: number;
  /** Where dropped-file copies go. Defaults to `<tmpdir realpath>/omnifex-dropped`. */
  droppedDir?: string;
  /** Largest dropped file accepted, in bytes. */
  maxDroppedBytes?: number;
  /** How long a dropped copy is kept. */
  droppedRetentionMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_MAX_DEPTH = 8;
// The WebSocket frame cap is 100 MiB and base64 is 4/3 the size.
const DEFAULT_MAX_DROPPED_BYTES = 50 * 1024 * 1024;
// Long enough for a resumed session to still find what it was given.
const DEFAULT_DROPPED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function extensionOf(name: string): string | undefined {
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return undefined;
  return name.slice(idx + 1);
}

function isHidden(name: string): boolean {
  return name.startsWith('.');
}

/**
 * Stable comparator: directories first, then files, alpha within each
 * group. Case-insensitive name compare matches what the FilePicker's
 * substring search already does, so list + search agree on ordering.
 */
function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.is_directory !== b.is_directory) return a.is_directory ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

export function createFilesystemService(
  opts: FilesystemServiceOptions = {},
): FilesystemService {
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxDroppedBytes = opts.maxDroppedBytes ?? DEFAULT_MAX_DROPPED_BYTES;
  const droppedRetentionMs = opts.droppedRetentionMs ?? DEFAULT_DROPPED_RETENTION_MS;
  const now = opts.now ?? Date.now;
  const droppedRoot = (): string => {
    const dir = opts.droppedDir ?? path.join(os.tmpdir(), 'omnifex-dropped');
    fs.mkdirSync(dir, { recursive: true });
    return fs.realpathSync(dir);
  };

  const sweepDropped = async (root: string): Promise<void> => {
    const cutoff = now() - droppedRetentionMs;
    let dirents: fs.Dirent[];
    try {
      dirents = await fsPromises.readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const full = path.join(root, d.name);
      try {
        const s = await fsPromises.stat(full);
        if (s.mtimeMs < cutoff) await fsPromises.rm(full, { recursive: true, force: true });
      } catch {
        /* vanished or unreadable — the next sweep tries again */
      }
    }
  };

  const saveDroppedFile = async (name: string, base64: string): Promise<string> => {
    const base = path.basename(name.replace(/\\/g, '/'));
    if (!base || base === '.' || base === '..') throw new Error(`Invalid file name: ${name}`);
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > maxDroppedBytes) {
      throw new Error(`${base} is too large to attach (${bytes.length} bytes, limit ${maxDroppedBytes})`);
    }
    const root = droppedRoot();
    await sweepDropped(root);
    const dir = path.join(root, randomUUID());
    await fsPromises.mkdir(dir);
    const target = path.join(dir, base);
    await fsPromises.writeFile(target, bytes);
    return target;
  };

  const listDirectoryContents = async (directoryPath: string): Promise<FileEntry[]> => {
    const stat = await fsPromises.stat(directoryPath);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${directoryPath}`);
    }
    const dirents = await fsPromises.readdir(directoryPath, { withFileTypes: true });
    const entries: FileEntry[] = [];
    for (const d of dirents) {
      if (isHidden(d.name)) continue;
      const full = path.join(directoryPath, d.name);
      if (d.isDirectory()) {
        entries.push({ name: d.name, path: full, is_directory: true, size: 0 });
        continue;
      }
      if (!d.isFile()) continue; // symlink / device / fifo — skip rather than stat
      let size = 0;
      try {
        const s = await fsPromises.stat(full);
        size = s.size;
      } catch {
        /* unreadable — leave size at 0 */
      }
      const ext = extensionOf(d.name);
      const entry: FileEntry = { name: d.name, path: full, is_directory: false, size };
      if (ext) entry.extension = ext;
      entries.push(entry);
    }
    entries.sort(compareEntries);
    return entries;
  };

  const searchFiles = async (basePath: string, query: string): Promise<FileEntry[]> => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const stat = await fsPromises.stat(basePath);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${basePath}`);
    }
    const needle = trimmed.toLowerCase();
    const results: FileEntry[] = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (results.length >= maxResults) return;
      if (depth > maxDepth) return;
      let dirents: import('node:fs').Dirent[];
      try {
        dirents = await fsPromises.readdir(dir, { withFileTypes: true });
      } catch {
        return; // permission denied / vanished — skip silently
      }
      for (const d of dirents) {
        if (results.length >= maxResults) return;
        if (isHidden(d.name)) continue;
        const full = path.join(dir, d.name);
        const matches = d.name.toLowerCase().includes(needle);
        if (d.isDirectory()) {
          if (matches) {
            results.push({ name: d.name, path: full, is_directory: true, size: 0 });
          }
          await walk(full, depth + 1);
          continue;
        }
        if (!d.isFile()) continue;
        if (!matches) continue;
        let size = 0;
        try {
          const s = await fsPromises.stat(full);
          size = s.size;
        } catch { /* unreadable — leave size at 0 */ }
        const ext = extensionOf(d.name);
        const entry: FileEntry = { name: d.name, path: full, is_directory: false, size };
        if (ext) entry.extension = ext;
        results.push(entry);
      }
    };

    await walk(basePath, 0);
    return results;
  };

  const createDirectory = async (directoryPath: string): Promise<string> => {
    if (!path.isAbsolute(directoryPath)) {
      throw new Error(`Path must be absolute: ${directoryPath}`);
    }
    try {
      await fsPromises.mkdir(directoryPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = await fsPromises.stat(directoryPath);
      if (!existing.isDirectory()) {
        throw new Error(`${directoryPath} exists and is not a folder.`);
      }
    }
    return directoryPath;
  };

  return { listDirectoryContents, searchFiles, createDirectory, saveDroppedFile };
}
