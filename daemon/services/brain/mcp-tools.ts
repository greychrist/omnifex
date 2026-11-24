import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Vault } from './vault';
import type { ParsedNote } from './types';
import type { ReadonlyVaultIndex, SearchHit, SearchOptions } from './search';
import { NoteParseError } from './frontmatter';
import { SECTION_ORDER, parseSections, type Sections } from './merge';
import { queryTerms } from './fts-query';

/** Must match what the capture source reads back. */
export interface CaptureFile {
  id: string;
  text: string;
  project: string | null;
  cwd: string | null;
  capturedAt: string;
}

export interface BrainMcpDeps {
  vault: Vault;
  /** Opened per call: a rebuild replaces the file, and a long-lived handle reads the unlinked inode. */
  openIndex: () => ReadonlyVaultIndex;
  captureDir: string;
  newId: () => string;
  now: () => Date;
}

export type ToolResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export const MAX_BODY_CHARS = 2000;

/** Shared across one response: `limit` permits 50 hits, and one tool result must not be a wall of text. */
export const MAX_TOTAL_BODY_CHARS = 10000;

/** Not search.ts's 20: a tool result costs tokens per row whether or not it is read. */
export const MCP_DEFAULT_LIMIT = 8;

/** The guard is on remaining budget: below it, a hit is listed by path, not a useless fragment. */
export const MIN_USEFUL_BODY_CHARS = 600;

export interface SearchResultHit extends SearchHit {
  body: string | null;
  bodyTruncated: boolean;
}

/** `Connected to` is deliberately absent, so links are dropped first: they are navigation, not answers. */
export const BODY_SECTION_PRIORITY: readonly string[] = [
  'Summary',
  'Key facts',
  'Decisions',
  'Timeline',
  'Open items',
  'Assistant notes',
];

const OMISSION_NOTICE = 'sections omitted, brain_read for the whole note';

interface PartialSection {
  name: string;
  lines: readonly string[];
  dropped: number;
  selected: boolean;
}

const INFLECTION = /(?:ing|ed|es|s)$/;

function lineMatches(line: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const lower = line.toLowerCase();
  return terms.some((term) => {
    if (lower.includes(term)) return true;
    const stem = term.replace(INFLECTION, '');
    return stem !== term && stem.length >= 4 && lower.includes(stem);
  });
}

/** The footer is required: silently dropping a section reintroduces the "absent or empty?" ambiguity. */
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
        `_(${String(partial.dropped)} more in this section${
          partial.selected ? '; lines matching the query kept' : ''
        })_`,
        '',
      );
    }
  }
  const rendered = parts.join('\n').trimEnd();
  const omitted = present.filter((name) => !keep.has(name) && name !== partial?.name);
  if (omitted.length === 0) return rendered;
  return `${rendered}\n\n_(${OMISSION_NOTICE}: ${omitted.join(', ')})_`;
}

/** Picks whole sections by priority, then spends the rest on the best one that did not fit. Falls back to a prefix: a stub is worse than a cut. */
function condenseBody(body: string, cap: number, terms: readonly string[]): string {
  const { title, sections } = parseSections(body);
  const present = [...sections]
    .filter(([, lines]) => lines.some((line) => line.trim() !== ''))
    .map(([name]) => name);
  if (present.length === 0) return body.slice(0, cap);

  // Unknown headings rank last but are never discarded: a hand-edited section is content.
  const known: readonly string[] = SECTION_ORDER;
  const order = [...BODY_SECTION_PRIORITY, ...present.filter((name) => !known.includes(name))];
  const matching = new Set(
    present.filter((name) => (sections.get(name) ?? []).some((line) => lineMatches(line, terms))),
  );
  const ranked = order.filter((name) => present.includes(name));
  const wanted = [
    ...ranked.filter((name) => name === 'Summary'),
    ...ranked.filter((name) => name !== 'Summary' && matching.has(name)),
    ...ranked.filter((name) => name !== 'Summary' && !matching.has(name)),
  ];

  const keep = new Set<string>();
  let spill: string | undefined;
  for (const name of wanted) {
    // Once a matching section has spilled, a non-matching one would spend the budget it needs.
    if (spill !== undefined && !matching.has(name)) break;
    const candidate = new Set(keep).add(name);
    if (renderCondensed(title, sections, candidate, null, present).length <= cap) {
      keep.add(name);
    } else if (matching.has(name)) {
      spill ??= name;
    }
  }
  spill ??= wanted.find((name) => !keep.has(name));

  let partial: PartialSection | null = null;
  if (spill !== undefined) {
    const name = spill;
    const lines = sections.get(name) ?? [];
    const chosen = new Set<number>();
    const toPartial = (): PartialSection => {
      const picked = [...chosen].sort((x, y) => x - y);
      return {
        name,
        lines: picked.map((i) => lines[i]),
        dropped: lines.length - picked.length,
        selected: picked.some((i, n) => i !== n),
      };
    };
    const tryAdd = (i: number): boolean => {
      chosen.add(i);
      if (renderCondensed(title, sections, keep, toPartial(), present).length <= cap) return true;
      chosen.delete(i);
      return false;
    };
    lines.forEach((line, i) => {
      if (lineMatches(line, terms)) tryAdd(i);
    });
    for (let i = 0; i < lines.length; i++) {
      if (!chosen.has(i) && !tryAdd(i)) break;
    }
    if (chosen.size > 0) partial = toPartial();
  }

  const out = renderCondensed(title, sections, keep, partial, present);
  // A single line can exceed the cap; only this guarantees the ceiling.
  return out.length <= cap ? out : out.slice(0, cap);
}

/** Markdown, not JSON: escaping cost 20% of the response and nothing parses it. */
export function renderSearchResult(query: string, hits: readonly SearchResultHit[]): string {
  if (hits.length === 0) {
    // Never a bare `[]`: it reads as a broken tool.
    return `No notes matched "${query}". Try fewer or different identifiers, or a related file name.`;
  }

  const full = hits.filter((h) => h.body !== null);
  const listed = hits.filter((h) => h.body === null);

  const parts: string[] = [
    `${String(hits.length)} note${hits.length === 1 ? '' : 's'} matched "${query}".`,
  ];

  for (const h of full) {
    parts.push(`## ${h.notePath} (${h.type})\n${h.body ?? ''}`);
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

/** `sources` is deliberately dropped: provenance the reader can do nothing with. */
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

/** Reads go through `vault.readNote`: its containment and hard-link checks keep accounts apart. A failed read degrades to one flagged hit. */
function attachBodies(hits: SearchHit[], vault: Vault, terms: readonly string[]): SearchResultHit[] {
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
    const condensed = condenseBody(body, cap, terms);
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
        // A missing index is reportable, not a crash: `read` works without it.
        return { ok: false, error: message(err) };
      }
      try {
        const hits = index.search(query, { type, project, limit: limit ?? MCP_DEFAULT_LIMIT });
        return { ok: true, hits: attachBodies(hits, deps.vault, queryTerms(query)) };
      } catch (err) {
        return { ok: false, error: message(err) };
      } finally {
        index.close();
      }
    },

    read({ path }) {
      try {
        // vault.readNote owns containment and the hard-link check; never re-implement them here.
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
        // One file per capture: concurrent server processes would interleave appends.
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
