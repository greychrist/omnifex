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

export interface BrainMcpTools {
  search(args: SearchOptions & { query: string }): ToolResult<{ hits: SearchHit[] }>;
  read(args: { path: string }): ToolResult<{ note: ParsedNote }>;
  remember(args: { text: string; project?: string; cwd?: string }): ToolResult<{ id: string }>;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
        return { ok: true, hits: index.search(query, { type, project, limit }) };
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
