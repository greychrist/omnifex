import type { NoteType, ParsedNote } from './types';

/**
 * A note reduced to the fields the Notes table sorts, filters and groups on.
 *
 * The list used to be paths and nothing else, so the pane could only ever
 * group by folder and sort by name — the two facts a path happens to carry.
 * Project ownership and dates live in frontmatter, which means reading every
 * note; this is the shape that trip pays for.
 */
export interface NoteMeta {
  relPath: string;
  /** Basename without `.md` — what the note calls itself. */
  title: string;
  type: NoteType;
  /** Display name of the owning project, or null when the note has none. */
  project: string | null;
  created: string;
  updated: string;
  /** ISO date of the last curation pass, or null if never curated. */
  curatedAt: string | null;
}

const stripMd = (s: string): string => (s.endsWith('.md') ? s.slice(0, -3) : s);

/**
 * The readable name behind a `project` frontmatter value.
 *
 * Stored as a wikilink (`"[[Projects/WIN]]"`) because that is what makes it
 * navigable in Obsidian, but a column of raw links sorts on the shared
 * `[[Projects/` prefix — every row identical until the eighth character — and
 * groups on nothing. Bare strings pass through unchanged: nothing guarantees
 * the link form, and an unparsed value is better shown than blanked.
 */
export function projectName(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const inner = raw.trim().replace(/^\[\[/, '').replace(/\]\]$/, '');
  // A piped link names its own display text, which is the more deliberate of
  // the two halves — the author wrote it to be read.
  const piped = inner.split('|');
  const chosen = piped.length > 1 ? piped[1] : piped[0];
  const name = stripMd(chosen.trim()).split('/').pop()?.trim() ?? '';
  return name === '' ? null : name;
}

export function toNoteMeta(relPath: string, note: ParsedNote): NoteMeta {
  const { frontmatter: fm } = note;
  return {
    relPath,
    title: stripMd(relPath.split('/').pop() ?? relPath),
    type: fm.type,
    project: projectName(fm.project),
    created: fm.created,
    updated: fm.updated,
    curatedAt: fm.curated_at ?? null,
  };
}
