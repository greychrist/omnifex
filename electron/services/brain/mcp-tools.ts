/**
 * The logic behind the three Brain MCP tools, with no SDK, no process and no
 * environment in it.
 *
 * Split from `electron/brain-mcp.ts` so the behaviour that matters — including
 * the isolation property, whose failure is a confidentiality breach rather
 * than a bug — is testable without spawning a stdio server.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Vault } from './vault';
import type { ParsedNote } from './types';
import type { ReadonlyVaultIndex, SearchHit, SearchOptions } from './search';
import { NoteParseError } from './frontmatter';
import { SECTION_ORDER, parseSections, type Sections } from './merge';

/** What `brain_remember` writes, and what the capture source reads back. */
export interface CaptureFile {
  id: string;
  text: string;
  project: string | null;
  cwd: string | null;
  /** ISO 8601. */
  capturedAt: string;
}

export interface BrainMcpDeps {
  vault: Vault;
  /**
   * Opens the index for one call. Called per search rather than once at
   * startup: a rebuild from the Brain tab replaces the database file, and a
   * long-lived handle would keep reading the unlinked inode.
   */
  openIndex: () => ReadonlyVaultIndex;
  captureDir: string;
  newId: () => string;
  now: () => Date;
}

export type ToolResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Longest body served inline for a single hit. Past this the caller gets the
 * highest-priority sections that fit and `bodyTruncated`, which is its cue to
 * `brain_read` the rest.
 */
export const MAX_BODY_CHARS = 2000;

/**
 * Ceiling on inline bodies across one response. `limit` permits 50 hits, and
 * without this a broad query against a vault of long notes returns a wall of
 * text as a single tool result.
 *
 * Measured on real traffic before this was lowered from 20,000: the median
 * search cost ~11K characters and the largest 27K — around 6.8K tokens for one
 * call. At 10,000 the top five or six notes still arrive whole, which is where
 * the answer has always been.
 */
export const MAX_TOTAL_BODY_CHARS = 10000;

/**
 * Hits returned when the caller names no `limit`.
 *
 * Deliberately not `search.ts`'s DEFAULT_LIMIT of 20, which is right for the
 * Brain tab: a scrollable list costs the reader nothing per row, while a tool
 * result costs tokens per row whether or not it is read. Twenty hits against a
 * 10,000-character body budget guarantees most of them arrive as bodyless
 * stubs — measured, seven of twenty.
 */
export const MCP_DEFAULT_LIMIT = 8;

/**
 * Least remaining budget worth starting a body with. Under this the hit is
 * listed by path instead.
 *
 * Raised from 200 once the total budget came down. Measured against the real
 * vault: the sixth through eighth hits of a default search came back holding
 * 377, 147 and 133 characters of notes that are 1,560 to 3,176 long — a heading
 * and a bullet or two, formatted exactly like a body and answering nothing.
 * The fragments are a symptom of an exhausted budget, not of small notes, so
 * the guard belongs on what is left to spend rather than on what came back.
 * `renderSearchResult` lists a hit that got no body as one line naming its path
 * and where the query matched: a tenth the cost, and honest about being a
 * pointer.
 */
export const MIN_USEFUL_BODY_CHARS = 600;

/**
 * A search hit with the note's text already attached.
 *
 * `brain_search` used to return `snippet` alone, which meant every usable
 * result cost a second `brain_read` round trip — one per note. In practice
 * that call often didn't happen: the model answered from the snippet, which is
 * a fragment cut mid-sentence by the FTS highlighter. Notes here are mostly
 * short, so carrying the body costs a few hundred tokens and removes the
 * round trip entirely.
 *
 * `snippet` stays: it marks *where* the query matched, which the body doesn't.
 */
export interface SearchResultHit extends SearchHit {
  /** Note body, condensed to `MAX_BODY_CHARS`. Null when unreadable or when the
   *  response budget is spent — `bodyTruncated` is true in both cases. */
  body: string | null;
  /** True when `body` is not the whole note, so `brain_read` still has more. */
  bodyTruncated: boolean;
}

/**
 * Which sections earn an over-cap body's budget, best first.
 *
 * `Connected to` is deliberately absent, so it is always the first thing
 * dropped. Wikilinks are navigation, not content, and on the largest real notes
 * they sit second in `SECTION_ORDER` — directly between the cap and everything
 * that answers a query. Measured on the shipped vault: `Projects/OmniFex.md` is
 * 25KB whose first 2000 characters are a 441-byte Summary followed by a
 * truncated link list, so a prefix slice answered every search about it with
 * navigation and no facts. `Key facts` and `Decisions` are 60-78% of the bytes
 * on notes that size and are where the answers actually live.
 */
export const BODY_SECTION_PRIORITY: readonly string[] = [
  'Summary',
  'Key facts',
  'Decisions',
  'Timeline',
  'Open items',
  'Assistant notes',
];

const OMISSION_NOTICE = 'sections omitted, brain_read for the whole note';

/** One section shown in part, with the count that was cut from it. */
interface PartialSection {
  name: string;
  lines: readonly string[];
  dropped: number;
}

/**
 * Render the kept sections in canonical order, footed by what was left out.
 *
 * The footer is not decoration. Every note carries all seven sections by
 * construction (`SECTION_ORDER`), precisely so a reader never has to ask
 * whether an absent section means "nothing to say"; dropping one silently here
 * would reintroduce exactly that ambiguity at the point of consumption. A
 * part-shown section is called out inside itself instead of in the footer,
 * because listing it as omitted while printing forty of its bullets would be
 * a straightforward lie.
 */
function renderCondensed(
  title: string | null,
  sections: Sections,
  keep: ReadonlySet<string>,
  partial: PartialSection | null,
  present: readonly string[],
): string {
  const parts: string[] = [];
  if (title !== null) parts.push(`# ${title}`, '');
  const seen = new Set<string>();
  for (const name of [...SECTION_ORDER, ...sections.keys()]) {
    if (seen.has(name)) continue;
    if (keep.has(name)) {
      seen.add(name);
      parts.push(`## ${name}`, ...(sections.get(name) ?? []), '');
    } else if (partial !== null && partial.name === name) {
      seen.add(name);
      parts.push(
        `## ${name}`,
        ...partial.lines,
        `_(${String(partial.dropped)} more in this section)_`,
        '',
      );
    }
  }
  const rendered = parts.join('\n').trimEnd();
  const omitted = present.filter((name) => !keep.has(name) && name !== partial?.name);
  if (omitted.length === 0) return rendered;
  return `${rendered}\n\n_(${OMISSION_NOTICE}: ${omitted.join(', ')})_`;
}

/**
 * Fit a body into `cap` by choosing sections rather than by cutting at `cap`.
 *
 * Two passes. The first takes whole sections in priority order; the second
 * spends whatever budget is left on the leading lines of the best section that
 * did not fit. The second pass is not a refinement — without it the largest
 * notes are the worst served, because the section carrying most of their
 * content is the one guaranteed to bust the cap on its own. Measured before it
 * existed: `Projects/OmniFex.md` returned its 441-byte Summary and nothing
 * else, spending 560 of 2000 characters.
 *
 * A body with no headings at all — auto-memory translations are prose under a
 * single `## Summary`, and some carry none — has nothing to select, so it falls
 * back to the prefix. That path is why this returns a string rather than
 * refusing: a stub body is worse than a cut one.
 */
function condenseBody(body: string, cap: number): string {
  const { title, sections } = parseSections(body);
  const present = [...sections]
    .filter(([, lines]) => lines.some((line) => line.trim() !== ''))
    .map(([name]) => name);
  if (present.length === 0) return body.slice(0, cap);

  // Unknown headings rank last but are never discarded outright: a hand-edited
  // note's own section is content, and silently dropping it would make the edit
  // box lossy in a way `Connected to` is not.
  const known: readonly string[] = SECTION_ORDER;
  const order = [...BODY_SECTION_PRIORITY, ...present.filter((name) => !known.includes(name))];
  const wanted = order.filter((name) => present.includes(name));

  const keep = new Set<string>();
  for (const name of wanted) {
    const candidate = new Set(keep).add(name);
    if (renderCondensed(title, sections, candidate, null, present).length <= cap) keep.add(name);
  }

  let partial: PartialSection | null = null;
  const spill = wanted.find((name) => !keep.has(name));
  if (spill !== undefined) {
    const lines = sections.get(spill) ?? [];
    // Grow one line at a time from an empty partial, so the footer and the
    // heading are already paid for and each step's cost is exactly the line.
    let best: PartialSection | null = null;
    for (let n = 1; n <= lines.length; n++) {
      const candidate: PartialSection = {
        name: spill,
        lines: lines.slice(0, n),
        dropped: lines.length - n,
      };
      if (renderCondensed(title, sections, keep, candidate, present).length > cap) break;
      best = candidate;
    }
    partial = best;
  }

  const out = renderCondensed(title, sections, keep, partial, present);
  // A single line can exceed the cap on its own, so nothing above guarantees
  // the ceiling. This does.
  return out.length <= cap ? out : out.slice(0, cap);
}

/**
 * Render a search response as the markdown the model will read anyway.
 *
 * The tool used to reply with `JSON.stringify(hits, null, 2)`. Notes are
 * markdown — mostly newlines, bullets and quoted identifiers — so that encoding
 * spent a measured 5,302 of 27,161 characters, 20% of the response, on `\\n`
 * escapes and indentation carrying no information. The structure JSON provided
 * was never used: nothing parses this result, a model reads it.
 *
 * Hits that got no body are listed rather than dropped. They are still the
 * ranked evidence that something exists — but as one line each, not as objects
 * whose null `body` reads like content withheld.
 */
export function renderSearchResult(query: string, hits: readonly SearchResultHit[]): string {
  if (hits.length === 0) {
    // Never a bare `[]`: that is indistinguishable from a broken tool, and
    // before `fts-query.ts` switched to OR the model met it on 44% of searches.
    return `No notes matched "${query}". Try fewer or different identifiers, or a related file name.`;
  }

  const full = hits.filter((h) => h.body !== null);
  const listed = hits.filter((h) => h.body === null);

  const parts: string[] = [
    `${String(hits.length)} note${hits.length === 1 ? '' : 's'} matched "${query}".`,
  ];

  for (const h of full) {
    parts.push(`## ${h.notePath} (${h.type})\n${h.body ?? ''}`);
    // The condensed body already footnotes which sections it dropped, but not
    // under which path to find them.
    if (h.bodyTruncated) parts.push(`→ brain_read "${h.notePath}" for the rest.`);
  }

  if (listed.length > 0) {
    parts.push(
      ['Also matched — brain_read to open:', ...listed.map((h) => `- ${h.notePath} (${h.type}): ${h.snippet}`)].join(
        '\n',
      ),
    );
  }

  return parts.join('\n\n');
}

/**
 * Render one whole note, for the call `renderSearchResult` points at.
 *
 * `sources` is deliberately dropped. It is the indexer's provenance — a list of
 * session ids that grows with every reindex and that the reader can do nothing
 * with — and on a well-worked note it is the longest field in the frontmatter.
 */
export function renderNote(notePath: string, note: ParsedNote): string {
  const { type, project, aliases, keywords, updated } = note.frontmatter;
  const meta = [
    `path: ${notePath}`,
    `type: ${type}`,
    ...(project === undefined ? [] : [`project: ${project}`]),
    ...(aliases.length === 0 ? [] : [`aliases: ${aliases.join(', ')}`]),
    ...(keywords.length === 0 ? [] : [`keywords: ${keywords.join(', ')}`]),
    `updated: ${updated}`,
  ];
  return `${meta.join('\n')}\n\n${note.body}`;
}

export interface BrainMcpTools {
  search(args: SearchOptions & { query: string }): ToolResult<{ hits: SearchResultHit[] }>;
  read(args: { path: string }): ToolResult<{ note: ParsedNote }>;
  remember(args: { text: string; project?: string; cwd?: string }): ToolResult<{ id: string }>;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Attach each hit's body, spending a shared budget across the response.
 *
 * Reads go through `vault.readNote`, not the filesystem directly: containment
 * and the hard-link rejection are the checks that keep one account's vault out
 * of another's, and a second, weaker copy of them here is exactly how that
 * property gets lost.
 *
 * A note that fails to read degrades to a flagged hit rather than failing the
 * search. The index is a snapshot, so a note deleted between indexing and
 * query is an ordinary race — losing the other hits over it would be a much
 * worse outcome than one stub.
 */
function attachBodies(hits: SearchHit[], vault: Vault): SearchResultHit[] {
  let budget = MAX_TOTAL_BODY_CHARS;
  return hits.map((hit) => {
    if (budget < MIN_USEFUL_BODY_CHARS) {
      return { ...hit, body: null, bodyTruncated: true };
    }
    let body: string;
    try {
      body = vault.readNote(hit.notePath).body;
    } catch {
      return { ...hit, body: null, bodyTruncated: true };
    }
    const cap = Math.min(MAX_BODY_CHARS, budget);
    if (body.length <= cap) {
      budget -= body.length;
      return { ...hit, body, bodyTruncated: false };
    }
    const condensed = condenseBody(body, cap);
    budget -= condensed.length;
    return { ...hit, body: condensed, bodyTruncated: true };
  });
}

export function createBrainMcpTools(deps: BrainMcpDeps): BrainMcpTools {
  return {
    search({ query, type, project, limit }) {
      let index: ReadonlyVaultIndex;
      try {
        index = deps.openIndex();
      } catch (err) {
        // A missing or stale index is a reportable condition, not a crash. The
        // Brain is auxiliary, and `read` still works entirely without it.
        return { ok: false, error: message(err) };
      }
      try {
        const hits = index.search(query, { type, project, limit: limit ?? MCP_DEFAULT_LIMIT });
        return { ok: true, hits: attachBodies(hits, deps.vault) };
      } catch (err) {
        return { ok: false, error: message(err) };
      } finally {
        index.close();
      }
    },

    read({ path }) {
      try {
        // Containment, the hard-link rejection and frontmatter parsing all
        // already live in vault.readNote. Re-implementing any of them here
        // would be a second, weaker copy of the checks that keep one account's
        // vault out of another's.
        return { ok: true, note: deps.vault.readNote(path) };
      } catch (err) {
        if (err instanceof NoteParseError) {
          return { ok: false, error: `cannot read note: ${err.message}` };
        }
        return { ok: false, error: message(err) };
      }
    },

    remember({ text, project, cwd }) {
      const trimmed = text.trim();
      if (!trimmed) return { ok: false, error: 'text is required' };

      const id = deps.newId();
      const payload: CaptureFile = {
        id,
        text: trimmed,
        project: project ?? null,
        cwd: cwd ?? null,
        capturedAt: deps.now().toISOString(),
      };
      try {
        mkdirSync(deps.captureDir, { recursive: true });
        // One file per capture rather than appends to a shared one: two open
        // sessions under one account mean two of these processes, and
        // concurrent appends to a single file interleave.
        writeFileSync(
          join(deps.captureDir, `${id}.json`),
          `${JSON.stringify(payload, null, 2)}\n`,
          'utf8',
        );
      } catch (err) {
        return { ok: false, error: message(err) };
      }
      return { ok: true, id };
    },
  };
}
