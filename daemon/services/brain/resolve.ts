export interface ExistingNote {
  path: string;
  title: string;
  aliases: string[];
}

export interface EntityNames {
  name: string;
  aliases: string[];
}

/** Case and separators only: a bad merge silently loses content, while a duplicate is visible and fixable. */
function fold(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, '');
}

function keysOf(note: ExistingNote): { titleKey: string; aliasKeys: Set<string> } {
  return {
    titleKey: fold(note.title),
    aliasKeys: new Set(note.aliases.map(fold).filter((k) => k.length > 0)),
  };
}

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

  // Sorted so ties resolve the same way; otherwise an entity ping-pongs between notes every run.
  const candidates = [...existing].sort((a, b) => a.path.localeCompare(b.path));

  // Title matches beat alias matches across all candidates.
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
