/**
 * Renderer-side wikilink handling.
 *
 * NOTE: `parseWikilinks` is a deliberate twin of the one in
 * `electron/services/brain/links.ts`. The renderer cannot import from
 * `electron/`, and round-tripping a note body back to the main process just to
 * have it point at its own links would cost an IPC call per render. If the
 * link grammar changes in one file, change it in the other — both have tests
 * over the same cases, so a drift shows up as a red suite.
 */

/**
 * `[[`, a target containing no `]`, `|` or `#`, an optional `|display` or
 * `#heading` tail, then `]]`.
 */
const WIKILINK = /\[\[([^\]|#\n]*)(?:[|#][^\]\n]*)?\]\]/g;

/** Link targets in first-seen order, deduped. Empty targets are dropped. */
export function parseWikilinks(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of body.matchAll(WIKILINK)) {
    const target = match[1].trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

const stripMd = (s: string): string => (s.endsWith('.md') ? s.slice(0, -3) : s);

/**
 * The note a wikilink target names, or null when it names none — or more
 * than one.
 *
 * Ambiguity resolving to null is the point. Two notes can share a title in
 * different folders, and silently opening whichever sorted first would show a
 * different note than the link's author meant: a wrong answer presented as a
 * right one. An inert link is honest.
 */
export function resolveWikilink(target: string, notePaths: string[]): string | null {
  const wanted = stripMd(target).toLowerCase();

  const exact = notePaths.filter((p) => stripMd(p).toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  const lastSegment = (s: string): string => stripMd(s).split('/').pop()?.toLowerCase() ?? '';
  const wantedTitle = lastSegment(target);
  const byTitle = notePaths.filter((p) => lastSegment(p) === wantedTitle);
  return byTitle.length === 1 ? byTitle[0] : null;
}

/** A note path's display title: its basename without the `.md` suffix. */
export function noteTitle(notePath: string): string {
  return stripMd(notePath.split('/').pop() ?? notePath);
}

/** A note path's top-level folder, or 'Other' for a note at the vault root. */
export function noteFolder(notePath: string): string {
  const parts = notePath.split('/');
  return parts.length > 1 ? parts[0] : 'Other';
}
