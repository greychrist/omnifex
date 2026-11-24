/** `true` excludes; absent means default. */
export type ProjectDecisions = Record<string, boolean>;

/** Unresolved spellings too: a cwd can arrive as either form. */
const TEMP_ROOTS = ['/private/', '/tmp/', '/var/folders/'];

/** Prefix match, deliberately: a repo merely named `tmp-ideas` is real work. */
export function isTempProject(path: string): boolean {
  return TEMP_ROOTS.some((root) => path.startsWith(root));
}

/** A recorded decision always wins over the temp default, in either direction. */
export function isExcludedProject(path: string, decisions: ProjectDecisions): boolean {
  return decisions[path] ?? isTempProject(path);
}

/** Fails open: failing closed would index nothing and look like a broken Brain. */
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
