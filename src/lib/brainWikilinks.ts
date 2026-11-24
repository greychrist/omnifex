// parseWikilinks twins daemon/services/brain/links.ts (the renderer cannot import daemon/): change both.

const WIKILINK = /\[\[([^\]|#\n]*)(?:[|#][^\]\n]*)?\]\]/g;

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

/** Ambiguity resolves to null: opening whichever same-titled note sorted first would be a wrong answer. */
export function resolveWikilink(target: string, notePaths: string[]): string | null {
  // Separators are insignificant, matching the daemon's linkMatchesNote and resolve.ts's fold().
  const key = (s: string): string => stripMd(s).toLowerCase().replace(/[\s_-]+/g, '');
  const wanted = key(target);

  const exact = notePaths.filter((p) => key(p) === wanted);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  const lastSegment = (s: string): string => key(stripMd(s).split('/').pop() ?? '');
  const wantedTitle = lastSegment(target);
  const byTitle = notePaths.filter((p) => lastSegment(p) === wantedTitle);
  return byTitle.length === 1 ? byTitle[0] : null;
}

export const WIKILINK_SCHEME = 'omnifex-wikilink:';

/** Fenced code is left alone: `[[...]]` there is code, not a link. */
export function wikilinksToMarkdown(body: string): string {
  return body
    .split(/(```)/)
    .map((segment, i) => {
      // Segments alternate text, fence, code, fence: index % 4 === 0 is prose.
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

export function wikilinkTarget(href: string | undefined): string | null {
  if (!href?.startsWith(WIKILINK_SCHEME)) return null;
  return decodeURIComponent(href.slice(WIKILINK_SCHEME.length));
}

export function noteTitle(notePath: string): string {
  return stripMd(notePath.split('/').pop() ?? notePath);
}

export function noteFolder(notePath: string): string {
  const parts = notePath.split('/');
  return parts.length > 1 ? parts[0] : 'Other';
}
