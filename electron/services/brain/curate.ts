import {
  SECTION_ORDER,
  appendUnique,
  parseSections,
  renderBody,
  type Sections,
} from './merge';
import type { ParsedNote } from './types';

/**
 * Curation: the one Brain pass that REMOVES (spec §1, §2).
 *
 * Pure, like `merge.ts`: no I/O, no model, no clock. Dates arrive as
 * parameters, because a function that reads its own clock turns its
 * idempotency test into a race against midnight.
 *
 * The load-bearing rule: THE MODEL NEVER CHOOSES WHAT TO DELETE. This module
 * picks the entries and computes their date range; the model is handed that
 * span and returns prose about it. So the operation that loses detail is a
 * pure function that can be tested exhaustively, and the operation that cannot
 * be tested — the model's judgement — can only add a sentence.
 */

/**
 * §10's numbers, inherited from Rowboat.
 *
 * `MIN_TIMELINE_ENTRIES` is STILL UNMEASURED, deliberately. The Plan 7 probe
 * could only build a vault from the auto-memory corpus, whose 83 notes all
 * carry no Timeline at all — so the histogram that would justify a number came
 * back entirely in the `none` bucket. The distribution only becomes meaningful
 * once session-extracted notes exist, which needs a Sonnet backfill.
 *
 * Read the Timeline histogram in the Brain tab's stats panel after a backfill
 * and set this from it. Until then it is Rowboat's number, not this vault's.
 */
export const MIN_TIMELINE_ENTRIES = 8;
export const RETAIN_RECENT = 5;
export const COOLDOWN_DAYS = 7;
export const MAX_NOTES_PER_RUN = 8;

/**
 * What a curation run produces. Declared here rather than in `curation.ts` so
 * the pure fold never imports the model module; `curation.ts`'s zod schema
 * infers this same shape and a compile-time check pins them together.
 */
export interface CurationResult {
  /** Prose summarizing the collapsed span. */
  collapsed: string;
  /** Facts recurring across the span, worth promoting into Key facts. */
  promotedFacts: string[];
}

/** A Timeline bullet `merge()` wrote: `- **YYYY-MM-DD**: text`. */
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

/** A real `YYYY-MM-DD`, not merely a string shaped like one. */
function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** Whole days from `from` to `to`. Both must already be ISO dates. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((b - a) / 86_400_000);
}

/**
 * Four guards, all of which must hold. See spec §2.
 *
 * The shape guard is what excludes translated auto-memory notes: their bodies
 * are `## Summary` plus the original prose and carry no Timeline, so freeform
 * notes are never curated without this needing to know they exist.
 */
export function qualifies(note: ParsedNote, today: string): boolean {
  const timeline = timelineOf(note);
  if (timeline === undefined) return false;
  if (timeline.filter(isDated).length < MIN_TIMELINE_ENTRIES) return false;

  // A hand-mangled `curated_at` is treated as absent rather than compared
  // against. Both guards below are string comparisons over ISO dates, and
  // garbage on either side of one makes its answer meaningless — a note stuck
  // forever behind an unparseable stamp is a worse failure than one curated
  // a second time.
  const curatedAt = note.frontmatter.curated_at;
  if (curatedAt === undefined || !isIsoDate(curatedAt)) return true;
  if (note.frontmatter.updated <= curatedAt) return false;
  return daysBetween(curatedAt, today) >= COOLDOWN_DAYS;
}

/**
 * The entries this fold would collapse: every dated one except the newest
 * `RETAIN_RECENT`.
 *
 * Exported so the prompt is built from exactly what the fold will remove. Two
 * independent spellings of "which entries" would eventually disagree, and the
 * model would then summarize a span that is not the span being deleted.
 */
export function collapsibleEntries(note: ParsedNote): string[] {
  const dated = (timelineOf(note) ?? []).filter(isDated);
  return dated.slice(0, Math.max(0, dated.length - RETAIN_RECENT));
}

/**
 * Model prose to one safe bullet-sized line.
 *
 * Headings are stripped and newlines flattened: either would end the bullet
 * and restructure the note, which is the failure the structured write path
 * exists to prevent.
 */
function flatten(prose: string): string {
  return prose
    .split('\n')
    .map((line) => line.replace(/^\s*#{1,6}\s+/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fold a curation result into a note.
 *
 * Only `Timeline` and `Key facts` are written — the sections `merge()` already
 * owns. `Summary`, `Connected to`, `Decisions`, `Open items` and
 * `Assistant notes` are carried through verbatim, so the invariant stays one
 * sentence: automated writes never touch human sections.
 */
export function curate(
  note: ParsedNote,
  result: CurationResult,
  opts: { date: string },
): ParsedNote {
  const parsed = parseSections(note.body);
  const title = parsed.title ?? '';

  const timeline = parsed.sections.get('Timeline') ?? [];
  const dated = timeline.filter(isDated);
  // Hand-written lines that are not dated bullets are never collapsed — this
  // pass may not delete what it cannot parse.
  const undated = timeline.filter((line) => !isDated(line) && line.trim() !== '');
  const cut = Math.max(0, dated.length - RETAIN_RECENT);
  const collapsing = dated.slice(0, cut);

  // Nothing to collapse: stamp and return. Reachable only by a caller that
  // skipped `qualifies`, and pinned by a test rather than left to chance.
  if (collapsing.length === 0) {
    return { frontmatter: { ...note.frontmatter, curated_at: opts.date }, body: note.body };
  }

  const first = dateOf(collapsing[0]);
  const last = dateOf(collapsing[collapsing.length - 1]);
  // The range is computed from the entries, never taken from the model.
  const span = first === last ? `**${first}**` : `**${first} – ${last}**`;
  const collapsed =
    `- ${span}: ${flatten(result.collapsed)} ` +
    `_(${String(collapsing.length)} entries collapsed)_`;

  const sections: Sections = new Map();
  for (const name of SECTION_ORDER) {
    sections.set(name, [...(parsed.sections.get(name) ?? [])]);
  }
  sections.set('Timeline', [collapsed, ...dated.slice(cut), ...undated]);
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
