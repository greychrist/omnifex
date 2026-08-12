/**
 * Which existing note an extracted entity belongs to.
 *
 * `merge()` dedups by note PATH, so an entity the model names differently on a
 * later run becomes a second note rather than an update to the first. That is
 * not hypothetical: two sessions about the same subsystem produced
 * `Subsystems/Brain memory vault.md` and `Subsystems/omnifex-brain-vault.md`.
 * At two sessions that is untidy; across a full backfill it fragments the
 * vault badly enough to undermine retrieval, which is the point of the Brain.
 *
 * Pure: names in, path out. No I/O, no model.
 */

export interface ExistingNote {
  path: string;
  title: string;
  aliases: string[];
}

export interface EntityNames {
  name: string;
  aliases: string[];
}

/**
 * Fold a name to its comparison form.
 *
 * Case and separators are the overwhelmingly common way one model run differs
 * from another for the same entity — `Brain memory vault` versus
 * `brain-memory-vault`. Everything else is left alone on purpose: matching
 * more aggressively (substrings, stemming, edit distance) would start merging
 * genuinely distinct entities, and a bad merge is worse than a duplicate. A
 * duplicate is visible in the tab and fixable; a bad merge silently loses one
 * entity's content inside another's note.
 */
function fold(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, '');
}

function keysOf(note: ExistingNote): { titleKey: string; aliasKeys: Set<string> } {
  return {
    titleKey: fold(note.title),
    aliasKeys: new Set(note.aliases.map(fold).filter((k) => k.length > 0)),
  };
}

/**
 * The path an entity should be written to: an existing note it matches, or a
 * fresh one from `fallback`.
 *
 * Matching is symmetric — the entity's name and aliases are both compared
 * against each note's title and aliases — because the model may name an entity
 * by what a previous run called an alias, or vice versa.
 */
export function resolveEntityPath(
  entity: EntityNames,
  existing: readonly ExistingNote[],
  fallback: (name: string) => string,
): string {
  const nameKey = fold(entity.name);
  const entityKeys = new Set(
    [entity.name, ...entity.aliases].map(fold).filter((k) => k.length > 0),
  );
  if (entityKeys.size === 0) return fallback(entity.name);

  // Sorted so two equally-good matches resolve the same way every time. Without
  // this an entity could ping-pong between two notes and rewrite both on every
  // run — the opposite of the idempotency the merge works to preserve.
  const candidates = [...existing].sort((a, b) => a.path.localeCompare(b.path));

  // A title is what a note IS; an alias is only something it is also called.
  // The more specific signal wins, and it is checked across all candidates
  // before any alias match is considered.
  for (const note of candidates) {
    if (keysOf(note).titleKey === nameKey) return note.path;
  }
  for (const note of candidates) {
    const { titleKey, aliasKeys } = keysOf(note);
    if (aliasKeys.has(nameKey)) return note.path;
    if (entityKeys.has(titleKey)) return note.path;
    for (const key of entityKeys) {
      if (aliasKeys.has(key)) return note.path;
    }
  }

  return fallback(entity.name);
}
