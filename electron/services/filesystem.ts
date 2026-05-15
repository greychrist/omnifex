/**
 * Filesystem service — powers the FilePicker's `@`-mention navigation.
 *
 * Two operations, both pure I/O with no account / config coupling:
 *
 *   - `listDirectoryContents(path)` returns one level of entries, sorted
 *     directories first then files (alpha within each group), with
 *     dot-prefixed names hidden by default.
 *   - `searchFiles(basePath, query)` walks `basePath` recursively, returning
 *     entries whose name contains `query` (case-insensitive). Dot-prefixed
 *     directories are skipped so we don't descend into `.git/` or
 *     `node_modules`-adjacent hidden trees. Results are capped so deep
 *     monorepos can't produce runaway responses.
 *
 * Both functions throw a regular `Error` on malformed input — the IPC
 * wrap-and-repackage layer in `electron/ipc/handlers.ts` will surface
 * `error.message` to the renderer.
 */

import * as fsPromises from 'node:fs/promises';
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
}

export interface FilesystemServiceOptions {
  /** Cap on entries returned by `searchFiles`. */
  maxResults?: number;
  /** Cap on directory-tree depth searched by `searchFiles`. */
  maxDepth?: number;
}

const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_MAX_DEPTH = 8;

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

  return { listDirectoryContents, searchFiles };
}
