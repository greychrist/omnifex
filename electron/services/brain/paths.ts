import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

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
