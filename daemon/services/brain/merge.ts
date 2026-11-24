import type { ExtractedEntity } from './extract';
import type { NoteFrontmatter, ParsedNote } from './types';

/**
 * Fold one extracted entity into a note. Pure: no I/O, no model, no clock.
 *
 * Purity is what makes the spec's hardest requirement testable. `merge` takes
 * its date from the caller rather than reading one, because a function that
 * reads `Date.now()` turns its own idempotency test into a race against
 * midnight.
 *
 * The property to preserve above all others (spec §9): indexing the same
 * session twice must produce a BYTE-IDENTICAL note. Two rules enforce it —
 * Timeline dedups on the provenance key rather than on text, and `updated`
 * bumps only when something actually changed. Without the second, every
 * re-index would be a fresh commit and the vault's git history would be noise.
 */

/** Where a merge's material came from. */
export interface Provenance {
  /** Stable key for the source item, e.g. `session:abc123`. Drives dedup. */
  sourceKey: string;
  /** ISO date (YYYY-MM-DD) supplied by the caller. Never read from a clock. */
  date: string;
  /** Wikilink to the owning project, e.g. `[[Projects/omnifex]]`. */
  projectLink?: string;
}

/**
 * Every note has all seven sections, always, even when empty.
 *
 * A uniform shape means a reader (human or model) never has to ask whether a
 * missing section means "nothing to say" or "this note predates the section".
 */
export const SECTION_ORDER = [
  'Summary',
  'Connected to',
  'Timeline',
  'Decisions',
  'Key facts',
  'Open items',
  'Assistant notes',
] as const;

type SectionName = (typeof SECTION_ORDER)[number];

/**
 * Sections merge NEVER writes.
 *
 * `Open items` and `Assistant notes` are human and curation territory. The
 * user edits notes in this app, so an extraction that overwrote their text
 * would make the tab's edit box a trap.
 */
const HUMAN_SECTIONS: ReadonlySet<string> = new Set(['Open items', 'Assistant notes']);

export type Sections = Map<string, string[]>;

/**
 * Split a note body into `## Heading` → lines.
 *
 * Parsing and re-rendering, rather than appending to raw text, is what lets
 * hand-written content in untouched sections survive a merge while the
 * sections merge does own get rewritten cleanly.
 *
 * Exported for `curate.ts`, which folds into the same seven-section shape. A
 * second Markdown section parser would drift from this one, and the two would
 * disagree about a note neither had a test for.
 */
export function parseSections(body: string): { title: string | null; sections: Sections } {
  const sections: Sections = new Map();
  let title: string | null = null;
  let current: string | null = null;

  for (const line of body.split('\n')) {
    if (title === null && line.startsWith('# ')) {
      title = line.slice(2).trim();
      continue;
    }
    if (line.startsWith('## ')) {
      current = line.slice(3).trim();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current !== null) sections.get(current)?.push(line);
  }

  // Trim leading/trailing blank lines per section so re-rendering is stable:
  // without this, each round trip would accumulate another blank line and no
  // merge would ever be idempotent.
  for (const [name, lines] of sections) {
    let start = 0;
    let end = lines.length;
    while (start < end && lines[start].trim() === '') start += 1;
    while (end > start && lines[end - 1].trim() === '') end -= 1;
    sections.set(name, lines.slice(start, end));
  }

  return { title, sections };
}

export function renderBody(title: string, sections: Sections): string {
  const parts: string[] = [`# ${title}`, ''];
  for (const name of SECTION_ORDER) {
    parts.push(`## ${name}`);
    const lines = sections.get(name) ?? [];
    if (lines.length > 0) parts.push(...lines);
    parts.push('');
  }
  // Exactly one trailing newline, always.
  return `${parts.join('\n').trimEnd()}\n`;
}

/** Union preserving first-seen order. */
export function union(existing: readonly string[], incoming: readonly string[]): string[] {
  const out = [...existing];
  for (const value of incoming) {
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/** Append only the bullets whose text is not already present. */
export function appendUnique(existing: readonly string[], incoming: readonly string[]): string[] {
  const out = existing.filter((l) => l.trim() !== '');
  for (const line of incoming) {
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/**
 * Sort Timeline bullets by their leading `**YYYY-MM-DD**` date.
 *
 * Stable for equal dates (entries from the same day keep insertion order), so
 * re-rendering an unchanged note cannot reorder it — which would break
 * idempotency just as surely as changing its text.
 */
function sortTimeline(lines: readonly string[]): string[] {
  const dated = lines.map((line, i) => ({
    line,
    i,
    date: /^- \*\*(\d{4}-\d{2}-\d{2})\*\*/.exec(line)?.[1] ?? '',
  }));
  dated.sort((a, b) => (a.date === b.date ? a.i - b.i : a.date.localeCompare(b.date)));
  return dated.map((d) => d.line);
}

/** ISO dates compare correctly as strings, so no Date parsing is needed. */
function minDate(a: string | undefined, b: string): string {
  return a === undefined || b < a ? b : a;
}

function maxDate(a: string | undefined, b: string): string {
  return a === undefined || b > a ? b : a;
}

function sectionsFor(existing: ParsedNote | null, name: SectionName): string[] {
  if (!existing) return [];
  return parseSections(existing.body).sections.get(name) ?? [];
}

export function merge(
  existing: ParsedNote | null,
  entity: ExtractedEntity,
  provenance: Provenance,
): ParsedNote {
  const alreadySeen = existing?.frontmatter.sources.includes(provenance.sourceKey) ?? false;

  const sections: Sections = new Map();

  // Summary is REPLACED, not accumulated: it describes the entity as it stands
  // now, and appending would turn it into a changelog that duplicates Timeline.
  sections.set('Summary', [entity.summary]);

  sections.set(
    'Connected to',
    appendUnique(
      sectionsFor(existing, 'Connected to'),
      entity.links.map((l) => `- [[${l.target}]] — ${l.relation}`),
    ),
  );

  // Timeline is the one section gated on provenance. Re-running extraction on
  // one session legitimately produces different wording, so text-matching here
  // would append a near-duplicate line on every re-index.
  const timelineAdditions =
    !alreadySeen && entity.timelineEntry
      ? [`- **${provenance.date}**: ${entity.timelineEntry}`]
      : [];
  sections.set(
    'Timeline',
    sortTimeline(appendUnique(sectionsFor(existing, 'Timeline'), timelineAdditions)),
  );

  sections.set(
    'Decisions',
    appendUnique(
      sectionsFor(existing, 'Decisions'),
      entity.decisions.map((d) => `- **${d.date}**: ${d.text}`),
    ),
  );

  sections.set(
    'Key facts',
    appendUnique(
      sectionsFor(existing, 'Key facts'),
      entity.keyFacts.map((f) => `- ${f}`),
    ),
  );

  for (const name of SECTION_ORDER) {
    if (HUMAN_SECTIONS.has(name)) sections.set(name, sectionsFor(existing, name));
  }

  const body = renderBody(entity.name, sections);

  const frontmatter: NoteFrontmatter = {
    ...existing?.frontmatter,
    type: entity.type,
    aliases: union(existing?.frontmatter.aliases ?? [], entity.aliases),
    keywords: union(existing?.frontmatter.keywords ?? [], entity.keywords),
    // Earliest and latest of everything this note has seen, rather than
    // "first write" and "this write". Backfill discovers newest-first, so an
    // older session is merged into a note a newer one created constantly —
    // taking `provenance.date` verbatim made `updated` PRECEDE `created` and
    // left most notes reporting the oldest session they saw as their last
    // touch. Both are still pure functions of the inputs, so idempotency holds.
    created: minDate(existing?.frontmatter.created, provenance.date),
    // Placeholder; resolved below once there is something to compare against.
    updated: maxDate(existing?.frontmatter.updated, provenance.date),
    sources: union(existing?.frontmatter.sources ?? [], [provenance.sourceKey]),
  };
  if (provenance.projectLink) frontmatter.project = provenance.projectLink;

  // `updated` bumps ONLY on a real change. Comparing the candidate against the
  // existing note — rather than stamping unconditionally — is what makes
  // re-indexing an unchanged session a no-op instead of a commit.
  const unchanged =
    existing !== null &&
    existing.body === body &&
    JSON.stringify({ ...existing.frontmatter, updated: '' }) ===
      JSON.stringify({ ...frontmatter, updated: '' });

  return {
    frontmatter: {
      ...frontmatter,
      updated: unchanged ? existing.frontmatter.updated : frontmatter.updated,
    },
    body,
  };
}
