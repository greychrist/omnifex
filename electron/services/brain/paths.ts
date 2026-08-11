import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

/**
 * Canonical form of a path, for identity comparison only.
 *
 * `resolve()` is purely lexical: it neither dereferences symlinks nor
 * case-folds. On a case-insensitive filesystem (macOS APFS by default)
 * "/v/Vault" and "/v/vault" are ONE directory that compares unequal, and a
 * symlink compares unequal to its target. Either alias would let two accounts
 * share one vault — and therefore one index database.
 *
 * `realpathSync.native()` resolves symlinks AND returns the on-disk casing, so
 * both aliases collapse to the same string. The target may not exist yet, so we
 * canonicalise the deepest EXISTING ancestor and re-append the remainder.
 */
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

/**
 * Validate a caller-supplied vault root and return it in absolute form.
 *
 * Canonicalising a path whose tail does not exist yet requires materialising
 * it, so the string has to be judged BEFORE it reaches the filesystem — an
 * unjudged one scaffolds a vault somewhere nobody asked for. Two inputs are
 * wrong often enough to name:
 *
 *   - empty or whitespace-only, which `resolve()`s to the process cwd (for a
 *     packaged Electron app that is `/`, and in dev it is the repo);
 *   - a leading `~` segment. Tilde expansion is a shell/UI convention that node
 *     never performs, so this would create a directory literally named `~`.
 */
export function resolveVaultRoot(input: string): string {
  // Trim first, then validate AND resolve the same trimmed string. Judging
  // `input.trim()` while resolving `input` lets a pasted path with a leading
  // space through: it is not empty, and `resolve()` then treats it as RELATIVE,
  // creating a directory literally named " " under the process cwd.
  const trimmed = typeof input === 'string' ? input.trim() : '';
  if (trimmed === '') {
    throw new Error('vault path is empty');
  }
  if (trimmed.split(/[\\/]/)[0] === '~') {
    throw new Error(`vault path must be expanded before it is stored: ${input}`);
  }
  return resolve(trimmed);
}

/**
 * True when `child` IS `parent` or sits underneath it.
 *
 * Both sides must already be `resolve()` or `realpathSync` output. Neither ever
 * emits a trailing separator except for the filesystem root itself — and the
 * root is exactly the case the naive form (`child.startsWith(parent + sep)`)
 * misses, because for parent "/" that prefix is "//", which nothing starts
 * with, so "/" would be judged to contain nothing at all.
 */
export function isSameOrInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Identity of the file or directory a path currently reaches, as `dev:ino`, or
 * null when it reaches nothing.
 *
 * A path string names something; it does not identify it. Two different
 * directories can wear the same name over time — a symlink swap, a move-aside,
 * a restore from backup — and a cached vault handle holds an open SQLite
 * descriptor plus a `Vault` whose real root was resolved once, both bound to
 * whatever the name meant at the moment it was opened. Comparing dev+ino is
 * what makes a cache entry describe the object rather than the name. It is also
 * the only way to see a HARD link, which gives one file two names inside two
 * different directories and leaves every path-based check satisfied.
 *
 * `statSync` follows symlinks deliberately: the identity that matters is the
 * one of the object actually reached. `bigint` because inode numbers can
 * exceed 2^53 on some filesystems.
 */
export function fsIdentity(path: string): string | null {
  try {
    const st = statSync(path, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}
