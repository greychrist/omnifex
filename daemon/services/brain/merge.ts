import type { ExtractedEntity } from './extract';
import type { NoteFrontmatter, ParsedNote } from './types';

/**
 * Pure and idempotent: indexing the same session twice must yield a byte-identical note.
 * Take the date from the caller, never a clock; `updated` bumps only on a real change.
 */

export interface Provenance {
  /** e.g. `session:abc123`; Timeline dedups on it. */
  sourceKey: string;
  /** YYYY-MM-DD from the caller; never read a clock. */
  date: string;
  projectLink?: string;
}

/** Every note has all seven sections, always, even when empty. */
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

/** Merge never writes these: they are human and curation territory. */
const HUMAN_SECTIONS: ReadonlySet<string> = new Set(['Open items', 'Assistant notes']);

export type Sections = Map<string, string[]>;

/** Shared with curate.ts: a second section parser would drift. */
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

  // Trim blank lines per section, or every round trip adds one and merge stops being idempotent.
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
  return `${parts.join('\n').trimEnd()}\n`;
}

export function union(existing: readonly string[], incoming: readonly string[]): string[] {
  const out = [...existing];
  for (const value of incoming) {
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

export function appendUnique(existing: readonly string[], incoming: readonly string[]): string[] {
  const out = existing.filter((l) => l.trim() !== '');
  for (const line of incoming) {
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/** Stable for equal dates: reordering would break idempotency. */
function sortTimeline(lines: readonly string[]): string[] {
  const dated = lines.map((line, i) => ({
    line,
    i,
    date: /^- \*\*(\d{4}-\d{2}-\d{2})\*\*/.exec(line)?.[1] ?? '',
  }));
  dated.sort((a, b) => (a.date === b.date ? a.i - b.i : a.date.localeCompare(b.date)));
  return dated.map((d) => d.line);
}

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

  // Replaced, not accumulated: appending would duplicate Timeline.
  sections.set('Summary', [entity.summary]);

  sections.set(
    'Connected to',
    appendUnique(
      sectionsFor(existing, 'Connected to'),
      entity.links.map((l) => `- [[${l.target}]] — ${l.relation}`),
    ),
  );

  // Gated on provenance, not text: re-extraction rewords, so text matching would append near-duplicates.
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
    // min/max, not first/this write: backfill runs newest-first, so verbatim dates put `updated` before `created`.
    created: minDate(existing?.frontmatter.created, provenance.date),
    updated: maxDate(existing?.frontmatter.updated, provenance.date),
    sources: union(existing?.frontmatter.sources ?? [], [provenance.sourceKey]),
  };
  if (provenance.projectLink) frontmatter.project = provenance.projectLink;

  // Bump only on a real change, or re-indexing an unchanged session makes a commit.
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
