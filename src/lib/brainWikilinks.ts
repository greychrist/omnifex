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

/** URL scheme used to smuggle a wikilink through the markdown renderer. */
export const WIKILINK_SCHEME = 'omnifex-wikilink:';

/**
 * Rewrite `[[wikilinks]]` as ordinary markdown links so the note body can go
 * through one markdown renderer rather than a hand-rolled segment splitter.
 * The link renderer recognises WIKILINK_SCHEME and turns those into buttons.
 *
 * Fenced code blocks are left alone: `[[...]]` inside a fence is code the user
 * wrote, and turning it into a link would both mangle the sample and invent a
 * navigation target that does not exist. Splitting on ``` and transforming only
 * the even segments is what keeps that true.
 */
export function wikilinksToMarkdown(body: string): string {
  return body
    .split(/(```)/)
    .map((segment, i) => {
      // Segments alternate: text, fence marker, code, fence marker, text…
      // so index % 4 === 0 is prose outside any fence.
      if (i % 4 !== 0) return segment;
      return segment.replace(WIKILINK, (whole, rawTarget: string) => {
        const target = rawTarget.trim();
        if (!target) return whole;
        const display = whole.slice(2, -2).split('|')[1]?.trim() ?? target;
        return `[${display}](${WIKILINK_SCHEME}${encodeURIComponent(target)})`;
      });
    })
    .join('');
}

/** The link target encoded into a WIKILINK_SCHEME href, or null. */
export function wikilinkTarget(href: string | undefined): string | null {
  if (!href?.startsWith(WIKILINK_SCHEME)) return null;
  return decodeURIComponent(href.slice(WIKILINK_SCHEME.length));
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
