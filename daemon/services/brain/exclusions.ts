/**
 * Which projects the Brain is allowed to touch.
 *
 * Pure: no database, no discovery, no clock. The registry enforces this at
 * every point that can reach the model, and keeping the decision here is what
 * makes "every point uses the same rule" checkable rather than aspirational.
 */

/** A recorded choice per project path. `true` excludes. Absent means "default". */
export type ProjectDecisions = Record<string, boolean>;

/**
 * Path prefixes that are scratch space, not work.
 *
 * `/private/` covers both macOS temp roots, since `/tmp` and `/var` are
 * symlinks into it and the CLI records the resolved form; the unresolved
 * spellings are listed too because a `cwd` can arrive either way.
 */
const TEMP_ROOTS = ['/private/', '/tmp/', '/var/folders/'];

/**
 * True for a project living in temp space.
 *
 * Prefix match, deliberately — a repo merely NAMED `tmp-ideas` or
 * `private-notes` is someone's actual work and must not be swept up.
 */
export function isTempProject(path: string): boolean {
  return TEMP_ROOTS.some((root) => path.startsWith(root));
}

/**
 * The single exclusion predicate.
 *
 * Temp projects are excluded by DEFAULT rather than by rule: sessions run in
 * `/private/tmp` are throwaway probes and summarisation scratch, and indexing
 * them spends tokens writing notes about the Brain watching itself. A recorded
 * decision always wins, in either direction — a default nobody can override is
 * not a default.
 */
export function isExcludedProject(path: string, decisions: ProjectDecisions): boolean {
  return decisions[path] ?? isTempProject(path);
}

/**
 * Read the stored decisions, tolerating anything.
 *
 * Fails OPEN: a mangled value reads as "no decisions recorded", so the
 * defaults apply and ordinary projects stay indexable. Failing closed would
 * index nothing and be indistinguishable from the Brain being broken.
 */
export function parseDecisions(raw: string | null): ProjectDecisions {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const out: ProjectDecisions = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}
