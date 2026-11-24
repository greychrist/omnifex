import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

/** Identity only: APFS case-folding or a symlink alias would let two accounts share one vault. */
export function canonicalPath(input: string): string {
  const abs = resolve(input);
  let probe = abs;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return abs;
    tail.unshift(basename(probe));
    probe = parent;
  }
  const real = realpathSync.native(probe);
  return tail.length > 0 ? join(real, ...tail) : real;
}

/** Judge before touching the filesystem: empty resolves to cwd, and node never expands `~`. */
export function resolveVaultRoot(input: string): string {
  // Validate and resolve the same trimmed string: a leading space would resolve as relative.
  const trimmed = typeof input === 'string' ? input.trim() : '';
  if (trimmed === '') {
    throw new Error('vault path is empty');
  }
  if (trimmed.split(/[\\/]/)[0] === '~') {
    throw new Error(`vault path must be expanded before it is stored: ${input}`);
  }
  return resolve(trimmed);
}

/** Inputs must be resolve()/realpath output. Handles parent "/", which a naive `parent + sep` prefix misses. */
export function isSameOrInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** dev:ino, so a cache entry names the object, not the path (symlink swap, hard link). bigint: inodes can exceed 2^53. */
export function fsIdentity(path: string): string | null {
  try {
    const st = statSync(path, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}
