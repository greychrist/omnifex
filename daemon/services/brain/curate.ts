import {
  SECTION_ORDER,
  appendUnique,
  parseSections,
  renderBody,
  type Sections,
} from './merge';
import type { ParsedNote } from './types';

/** Pure, like merge.ts: no I/O, no model, no clock. The model never chooses what to delete; this module picks the span. */

/** Inherited from Rowboat, not yet measured against a real vault. */
export const MIN_TIMELINE_ENTRIES = 8;
export const RETAIN_RECENT = 5;
export const COOLDOWN_DAYS = 7;
export const MAX_NOTES_PER_RUN = 8;

/** Separate from Timeline's on purpose: the sections differ in volume 3-5x. */
export const MIN_DECISION_ENTRIES = 8;
export const RETAIN_RECENT_DECISIONS = 5;

/** Declared here so the pure fold never imports curation.ts; a compile-time check pins the zod schema to it. */
export interface CurationResult {
  collapsed: string;
  collapsedDecisions?: string;
  promotedFacts: string[];
}

const DATED_ENTRY = /^- \*\*(\d{4}-\d{2}-\d{2})\*\*/;

function isDated(line: string): boolean {
  return DATED_ENTRY.test(line);
}

function dateOf(line: string): string {
  return DATED_ENTRY.exec(line)?.[1] ?? '';
}

function timelineOf(note: ParsedNote): string[] | undefined {
  return parseSections(note.body).sections.get('Timeline');
}

function decisionsOf(note: ParsedNote): string[] | undefined {
  return parseSections(note.body).sections.get('Decisions');
}

/** One rule for both sections: a second spelling would hand the model a span other than the one removed. */
function collapsibleIn(lines: readonly string[] | undefined, retain: number): string[] {
  const dated = (lines ?? []).filter(isDated);
  return dated.slice(0, Math.max(0, dated.length - retain));
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((b - a) / 86_400_000);
}

/** Length is a disjunction over Timeline and Decisions; a note with neither (auto-memory) never qualifies. */
export function qualifies(note: ParsedNote, today: string): boolean {
  const timelineLength = (timelineOf(note) ?? []).filter(isDated).length;
  const decisionLength = (decisionsOf(note) ?? []).filter(isDated).length;
  if (timelineLength < MIN_TIMELINE_ENTRIES && decisionLength < MIN_DECISION_ENTRIES) {
    return false;
  }

  // A mangled `curated_at` reads as absent: stuck forever is worse than curated twice.
  const curatedAt = note.frontmatter.curated_at;
  if (curatedAt === undefined || !isIsoDate(curatedAt)) return true;
  if (note.frontmatter.updated <= curatedAt) return false;
  return daysBetween(curatedAt, today) >= COOLDOWN_DAYS;
}

/** Exported so the prompt is built from exactly what the fold removes. */
export function collapsibleEntries(note: ParsedNote): string[] {
  return collapsibleIn(timelineOf(note), RETAIN_RECENT);
}

export function collapsibleDecisions(note: ParsedNote): string[] {
  return collapsibleIn(decisionsOf(note), RETAIN_RECENT_DECISIONS);
}

/** Headings or newlines would end the bullet and restructure the note. */
function flatten(prose: string): string {
  return prose
    .split('\n')
    .map((line) => line.replace(/^\s*#{1,6}\s+/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collapseSection(
  lines: readonly string[],
  retain: number,
  prose: string,
  noun: string,
): string[] {
  const dated = lines.filter(isDated);
  // Never collapse what this pass cannot parse.
  const undated = lines.filter((line) => !isDated(line) && line.trim() !== '');
  const cut = Math.max(0, dated.length - retain);
  const collapsing = dated.slice(0, cut);

  const first = dateOf(collapsing[0]);
  const last = dateOf(collapsing[collapsing.length - 1]);
  // The range is computed from the bullets, never taken from the model.
  const span = first === last ? `**${first}**` : `**${first} – ${last}**`;
  const marker = `_(${String(collapsing.length)} ${noun} collapsed)_`;
  const body = [flatten(prose), marker].filter((part) => part !== '').join(' ');

  return [`- ${span}: ${body}`, ...dated.slice(cut), ...undated];
}

/** Never touches human sections. Key facts is append-only: collapsing oldest-first would delete the best-established facts. */
export function curate(
  note: ParsedNote,
  result: CurationResult,
  opts: { date: string },
): ParsedNote {
  const parsed = parseSections(note.body);
  const title = parsed.title ?? '';

  const timeline = parsed.sections.get('Timeline') ?? [];
  const decisions = parsed.sections.get('Decisions') ?? [];
  const timelineCut = collapsibleIn(timeline, RETAIN_RECENT).length;
  const decisionCut = collapsibleIn(decisions, RETAIN_RECENT_DECISIONS).length;

  if (timelineCut === 0 && decisionCut === 0) {
    return { frontmatter: { ...note.frontmatter, curated_at: opts.date }, body: note.body };
  }

  const sections: Sections = new Map();
  for (const name of SECTION_ORDER) {
    sections.set(name, [...(parsed.sections.get(name) ?? [])]);
  }
  if (timelineCut > 0) {
    sections.set('Timeline', collapseSection(timeline, RETAIN_RECENT, result.collapsed, 'entries'));
  }
  if (decisionCut > 0) {
    sections.set(
      'Decisions',
      collapseSection(
        decisions,
        RETAIN_RECENT_DECISIONS,
        result.collapsedDecisions ?? '',
        'decisions',
      ),
    );
  }
  sections.set(
    'Key facts',
    appendUnique(
      parsed.sections.get('Key facts') ?? [],
      result.promotedFacts.map((f) => `- ${flatten(f)}`),
    ),
  );

  return {
    frontmatter: { ...note.frontmatter, curated_at: opts.date },
    body: renderBody(title, sections),
  };
}
