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
 * `Decisions`' own thresholds (Plan 9 §1), separate from Timeline's on purpose.
 *
 * The two sections differ in volume by 3-5x: `merge()` writes exactly one
 * Timeline entry per indexed source, while a single session routinely yields
 * several decisions. Measured on the live vault, the largest note carries 38
 * decisions against 7 Timeline entries. Sharing a constant would mean the next
 * reason to retune one silently retunes the other.
 */
export const MIN_DECISION_ENTRIES = 8;
export const RETAIN_RECENT_DECISIONS = 5;

/**
 * What a curation run produces. Declared here rather than in `curation.ts` so
 * the pure fold never imports the model module; `curation.ts`'s zod schema
 * infers this same shape and a compile-time check pins them together.
 */
export interface CurationResult {
  /** Prose summarizing the collapsed Timeline span. */
  collapsed: string;
  /**
   * Prose summarizing the collapsed `Decisions` span.
   *
   * Optional because a note qualifying on Timeline alone has no decisions span
   * to describe, and the prompt omits the block entirely in that case rather
   * than inviting the model to summarize an absent one.
   */
  collapsedDecisions?: string;
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

function decisionsOf(note: ParsedNote): string[] | undefined {
  return parseSections(note.body).sections.get('Decisions');
}

/**
 * The dated bullets of one section beyond its retain floor.
 *
 * `Timeline` and `Decisions` collapse by the same rule against different
 * constants, so the rule is written once. A second spelling of "which bullets"
 * would eventually disagree with this one, and the model would then be handed a
 * span that is not the span being removed.
 */
function collapsibleIn(lines: readonly string[] | undefined, retain: number): string[] {
  const dated = (lines ?? []).filter(isDated);
  return dated.slice(0, Math.max(0, dated.length - retain));
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
 * Length, then freshness, then cooldown. See spec §2 and Plan 9 §2.
 *
 * Length is a DISJUNCTION over the two collapsible sections: a note qualifies
 * on a long `Timeline` or a long `Decisions`, independently. Gating on Timeline
 * alone meant gating on the slowest-growing section — fourteen notes carrying
 * eight or more decisions, including the largest note in the vault at 38, could
 * never qualify.
 *
 * The old explicit shape guard is gone and nothing replaced it: a translated
 * auto-memory note is `## Summary` plus prose and has neither section, so both
 * arms are zero and it is never curated. Freeform notes stay excluded without
 * this function needing to know they exist.
 */
export function qualifies(note: ParsedNote, today: string): boolean {
  const timelineLength = (timelineOf(note) ?? []).filter(isDated).length;
  const decisionLength = (decisionsOf(note) ?? []).filter(isDated).length;
  if (timelineLength < MIN_TIMELINE_ENTRIES && decisionLength < MIN_DECISION_ENTRIES) {
    return false;
  }

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
  return collapsibleIn(timelineOf(note), RETAIN_RECENT);
}

/** `collapsibleEntries`' twin for `Decisions`. Exported for the same reason. */
export function collapsibleDecisions(note: ParsedNote): string[] {
  return collapsibleIn(decisionsOf(note), RETAIN_RECENT_DECISIONS);
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
 * Rebuild one section as `[collapsed bullet, retained tail, hand-written lines]`.
 *
 * `noun` names the unit in the `_(N ... collapsed)_` marker, so `Timeline` reads
 * "entries" and `Decisions` reads "decisions" from one implementation.
 */
function collapseSection(
  lines: readonly string[],
  retain: number,
  prose: string,
  noun: string,
): string[] {
  const dated = lines.filter(isDated);
  // Hand-written lines that are not dated bullets are never collapsed — this
  // pass may not delete what it cannot parse.
  const undated = lines.filter((line) => !isDated(line) && line.trim() !== '');
  const cut = Math.max(0, dated.length - retain);
  const collapsing = dated.slice(0, cut);

  const first = dateOf(collapsing[0]);
  const last = dateOf(collapsing[collapsing.length - 1]);
  // The range is computed from the bullets, never taken from the model.
  const span = first === last ? `**${first}**` : `**${first} – ${last}**`;
  const marker = `_(${String(collapsing.length)} ${noun} collapsed)_`;
  // A model that returns nothing for a span still gets a well-formed bullet
  // rather than one with a hole where the prose should be.
  const body = [flatten(prose), marker].filter((part) => part !== '').join(' ');

  return [`- ${span}: ${body}`, ...dated.slice(cut), ...undated];
}

/**
 * Fold a curation result into a note.
 *
 * Writes `Timeline`, `Decisions` and `Key facts` — the sections `merge()` owns.
 * `Summary`, `Connected to`, `Open items` and `Assistant notes` are carried
 * through verbatim, so the invariant stays one sentence: automated writes never
 * touch human sections. `Decisions` joined this list in Plan 9 because it is
 * `merge()`-owned and dated, not because the invariant was relaxed.
 *
 * `Key facts` is still only appended to, never collapsed. Plan 9 §3: none of
 * its 1,902 bullets carry a date, its only available order is age, and age
 * predicts a fact's DURABILITY rather than its staleness — collapsing oldest
 * first would delete the best-established facts first.
 */
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

  // Nothing to collapse in either section: stamp and return. Reachable only by
  // a caller that skipped `qualifies`, and pinned by a test rather than left to
  // chance.
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
