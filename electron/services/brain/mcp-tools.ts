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
 * Longest body served inline for a single hit. Past this the caller gets a
 * prefix and `bodyTruncated`, which is its cue to `brain_read` the rest.
 */
export const MAX_BODY_CHARS = 2000;

/**
 * Ceiling on inline bodies across one response. `limit` permits 50 hits, and
 * without this a broad query against a vault of long notes returns a wall of
 * text as a single tool result.
 */
export const MAX_TOTAL_BODY_CHARS = 20000;

/**
 * Below this much remaining budget, serve no body at all. A 40-character
 * prefix is not worth the tokens and reads as content rather than as the stub
 * it is.
 */
const MIN_USEFUL_BODY_CHARS = 200;

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
  /** Note body, capped per `MAX_BODY_CHARS`. Null when unreadable or when the
   *  response budget is spent — `bodyTruncated` is true in both cases. */
  body: string | null;
  /** True when `body` is not the whole note, so `brain_read` still has more. */
  bodyTruncated: boolean;
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
    budget -= Math.min(body.length, cap);
    return body.length <= cap
      ? { ...hit, body, bodyTruncated: false }
      : { ...hit, body: body.slice(0, cap), bodyTruncated: true };
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
        const hits = index.search(query, { type, project, limit });
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
