/**
 * Wikilink parsing. `[[wikilinks]]` are the ONLY graph structure in a vault —
 * there is no separate edge table — so this grammar is the whole link model.
 *
 * NOTE: `src/lib/brainWikilinks.ts` holds a deliberate renderer-side twin of
 * `parseWikilinks`. The renderer cannot import from `electron/`, and shipping
 * a note body back across IPC just to have the main process point at its own
 * links would cost a round trip per render. If the link grammar changes here,
 * change it there too — both have their own tests over the same cases.
 */

/**
 * `[[`, a target containing no `]`, `|` or `#`, an optional `|display` or
 * `#heading` tail, then `]]`. Targets are captured raw and trimmed by the
 * caller loop, so `[[  A  ]]` and `[[A]]` are one target.
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

/**
 * True when `target` names the note at `notePath`.
 *
 * A target may be a bare title or a vault-relative path, with or without the
 * `.md` suffix, so comparison is on the final segment — matching how a vault's
 * filenames are derived from note titles in the first place
 * (`vault.notePath`).
 *
 * Separators (spaces, `-`, `_`) are insignificant, the same normalization
 * `resolve.ts`'s `fold()` applies when deciding whether two entities are the
 * same thing. Treating them as significant HERE while ignoring them THERE made
 * `foo-bar` and `foo_bar` one entity but two link targets — measured on a real
 * auto-memory corpus, that cost 5 of 29 links, all of them hyphenated
 * references to underscored filenames.
 */
export function linkMatchesNote(target: string, notePath: string): boolean {
  const key = (s: string): string => {
    const seg = s.split('/').pop() ?? s;
    return (seg.endsWith('.md') ? seg.slice(0, -3) : seg).toLowerCase().replace(/[\s_-]+/g, '');
  };
  return key(target) === key(notePath);
}
