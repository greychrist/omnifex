// src/lib/brainWikilinks.ts twins parseWikilinks: change the grammar in both.

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

/** Separators are insignificant, matching resolve.ts fold(); the two must agree. */
export function linkMatchesNote(target: string, notePath: string): boolean {
  const key = (s: string): string => {
    const seg = s.split('/').pop() ?? s;
    return (seg.endsWith('.md') ? seg.slice(0, -3) : seg).toLowerCase().replace(/[\s_-]+/g, '');
  };
  return key(target) === key(notePath);
}
