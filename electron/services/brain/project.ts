import path from 'node:path';
import type { ItemMetadata } from './sources/types';

/**
 * Which project a piece of indexed material belongs to.
 *
 * `merge()` has always honoured `provenance.projectLink`, `NoteFrontmatter` has
 * always had a `project` field, and the FTS index has always carried a
 * `project` column weighted as a filter. Nothing ever computed the value. The
 * result was a field empty on every note in every vault, and a documented
 * `brain_search` `project` filter that could only ever return zero hits —
 * silently, as an empty result rather than an error.
 *
 * The value is derived from the path the material came from, never asked of the
 * model. Every source kind already knows that path: a session and a capture
 * carry the `cwd` they ran in, an instruction file carries its `repoPath`. A
 * model-supplied project name would be one more thing to get wrong, on a field
 * whose entire purpose is exact-match filtering.
 */

/**
 * Fold a name to its comparison form.
 *
 * Deliberately the same shape as `resolve.ts`'s fold, and for the same reason:
 * case and separators are how one spelling of an entity differs from another —
 * the repo directory is `omnifex` while the note is `Projects/OmniFex.md`, and
 * `wombeats-ios` means `WombBeats-iOS`. Not shared with `resolve.ts` because
 * these fold different things (project directories, not model-supplied entity
 * names) and coupling them would mean a change made for one silently retargets
 * the other.
 */
function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The path a kind of material came from, or null when it has none. */
function sourcePath(metadata: ItemMetadata): string | null {
  switch (metadata.kind) {
    // Named differently by each adapter, but the same fact: the working
    // directory the material came from.
    case 'session':
      return metadata.projectPath;
    case 'capture':
      return metadata.cwd;
    case 'artifact':
      return metadata.repoPath;
    default: {
      // Exhaustive: a new source kind must decide what its project is rather
      // than falling through to an unattributed note.
      const _never: never = metadata;
      return _never;
    }
  }
}

/** A note already in `Projects/`, in the shape `resolve.ts` compares against. */
export interface ExistingProject {
  title: string;
  aliases: string[];
}

/**
 * The wikilink naming this item's project, or undefined when the item's own
 * sources cannot say.
 *
 * Undefined rather than a guess: the adapters already refuse to invent a `cwd`
 * they could not read, and inventing one here would put a fabricated
 * attribution on a field people filter by. `merge()` leaves the field alone
 * when this returns undefined, so an item that cannot say never overwrites an
 * attribution an earlier, better-informed run made.
 *
 * Aliases are matched as well as titles, for the same reason `resolve.ts` does
 * it: a directory name is frequently not the project's own spelling of itself.
 * The `wombeats-ios` checkout is `Projects/WombBeats-iOS.md`, which no amount
 * of case-and-separator folding will reach — but the note already lists
 * `wombeats-ios` among its aliases, because that is the name the material it
 * was built from used.
 *
 * @param projects Notes already in `Projects/`, so an existing note is linked
 *   by its own spelling rather than by the directory's.
 */
export function projectLinkFor(
  metadata: ItemMetadata,
  projects: ExistingProject[],
): string | undefined {
  const from = sourcePath(metadata);
  if (!from) return undefined;

  // basename of a path with a trailing slash is '' on some inputs; normalise
  // first so `/repos/WIN/` and `/repos/WIN` attribute identically.
  const dir = path.basename(from.replace(/[/\\]+$/, ''));
  if (!dir) return undefined;

  const key = fold(dir);
  if (!key) return undefined;

  // An existing note's own spelling wins, so the link resolves and the filter
  // value matches the note it names. Sorted before matching so the result does
  // not depend on the order the vault happened to list its notes in — this
  // function is relied on to be pure across re-indexing.
  const sorted = [...projects].sort((a, b) => a.title.localeCompare(b.title));

  // Title before alias, as in `resolve.ts`: a title is what a note IS, an alias
  // only something it is also called, so a title match must not lose to an
  // alias match on an unrelated note that happens to sort earlier.
  const byTitle = sorted.find((p) => fold(p.title) === key);
  const match = byTitle ?? sorted.find((p) => p.aliases.some((a) => fold(a) === key));

  return `[[Projects/${match?.title ?? dir}]]`;
}
