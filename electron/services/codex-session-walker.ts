/**
 * CodexSessionWalker — discover Codex CLI session rollouts on disk.
 *
 * The Codex CLI writes one JSONL rollout per conversation under
 * `~/.codex/sessions/`. Real-world layout is `YYYY/MM/DD/rollout-…-<uuid>.jsonl`,
 * but we walk the tree generically so flat fixtures and future shape changes
 * keep working. The first record of a rollout is normally
 * `{ "type": "session_meta", "payload": { "id": "<uuid>", "cwd": "…" } }`
 * which is what we lift the conversationId + projectPath from. When that
 * record is missing or garbled we still surface the file: the conversationId
 * falls back to the filename (trailing-UUID match, with a plain
 * `<uuid>.jsonl` fallback for future-proofing), and projectPath becomes null.
 *
 * Defensive by design:
 *  - A missing `sessionsDir` is treated as "no Codex sessions yet" → [].
 *  - Malformed JSONL is skipped silently per-file; the walker never throws
 *    out from under the renderer just because one rollout is corrupt.
 *
 * Pure: no IPC, no logging, no main-process globals. Plays cleanly with the
 * one-shot service-factory pattern the rest of `electron/services/` uses.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Account } from './accounts';
import { mapLimit } from './util/map-limit';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CodexSessionEntry {
  /** Codex conversation uuid — what gets passed back to the engine as `resumeSessionId`. */
  conversationId: string;
  /** Working directory recorded on the rollout, or null when none was logged. */
  projectPath: string | null;
  /** File mtime as an ISO string. Used for the SessionList recency sort. */
  lastActivity: string;
  /** Absolute path to the rollout `.jsonl` on disk. */
  jsonlPath: string;
  /** Codex account (its config dir owns this rollout) this session belongs to. */
  accountId: number;
}

export interface CodexSessionWalker {
  listSessions(): Promise<CodexSessionEntry[]>;
}

export interface CreateCodexSessionWalkerDeps {
  /** Returns the Codex accounts whose `<config_dir>/sessions` dirs to scan. */
  listCodexAccounts: () => Account[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk `rootDir` recursively and yield absolute paths of every `*.jsonl`
 * file found. Tolerates a missing root (returns nothing) and tolerates
 * per-directory `readdir` failures (skips the offending subtree without
 * throwing). Async: it runs on the daemon's one event loop, and Codex keeps
 * one directory per day of history. Order is depth-first readdir order,
 * deterministic before the mtime sort.
 */
async function collectJsonlFiles(rootDir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const ent of entries) {
    const full = path.join(rootDir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await collectJsonlFiles(full)));
    } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

/** Read size for the first-line scan. */
const HEAD_CHUNK = 64 * 1024;
/**
 * Longest first line read. `session_meta` carries the base instructions, so it
 * runs to tens of KB — but a rollout whose first line is past this is not one
 * the walker can use, and reading on would be reading the whole file again.
 */
const MAX_FIRST_LINE = 4 * 1024 * 1024;
/** Concurrent rollout reads; see util/map-limit.ts for why it is bounded. */
const FS_CONCURRENCY = 8;

/**
 * The rollout's first line, read a chunk at a time until its newline — not
 * the whole file, which grows to many MB. Null when unreadable or when the
 * line is longer than `MAX_FIRST_LINE`.
 */
async function readFirstLine(filePath: string): Promise<string | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.alloc(HEAD_CHUNK);
      const { bytesRead } = await handle.read(buf, 0, HEAD_CHUNK, total);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      const nl = chunk.indexOf(0x0a);
      if (nl !== -1) {
        chunks.push(chunk.subarray(0, nl));
        break;
      }
      chunks.push(chunk);
      total += bytesRead;
      if (total >= MAX_FIRST_LINE) return null;
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Recognized "working directory" field names on a Codex session-meta payload.
 * `cwd` is the canonical Codex field (verified against real rollouts on
 * 2026-05-27); the other two cover documented-but-uncommon shapes from
 * older CLI builds and generic JSONL emitters that have appeared in issues.
 */
const PROJECT_PATH_KEYS = ['cwd', 'project_path', 'working_directory'] as const;

/** UUID-tail matcher for `rollout-<timestamp>-<uuid>.jsonl` filenames. */
const FILENAME_UUID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** Plain `<uuid>.jsonl` future-proofing fallback. */
const FILENAME_UUID_BARE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * Derive a conversationId from a rollout filename. Order of preference:
 *  1. trailing UUID in the filename (covers `rollout-<ts>-<uuid>.jsonl`),
 *  2. bare `<uuid>.jsonl`,
 *  3. final fallback — the filename minus the `.jsonl` extension.
 * The last branch keeps even non-UUID filenames addressable rather than
 * silently disappearing from the list.
 */
function conversationIdFromFilename(filePath: string): string {
  const base = path.basename(filePath);
  const tail = FILENAME_UUID_TAIL.exec(base);
  if (tail) return tail[1].toLowerCase();
  const bare = FILENAME_UUID_BARE.exec(base);
  if (bare) return bare[1].toLowerCase();
  return base.replace(/\.jsonl$/i, '');
}

/**
 * Read the first JSON record of a rollout and extract whatever metadata it
 * exposes. Returns nulls (not throws) for every flavor of failure — empty
 * file, unreadable file, malformed first line, missing payload — so the
 * caller can still surface the row with filename-derived defaults.
 */
async function readFirstRecordMeta(
  filePath: string,
): Promise<{ conversationId: string | null; projectPath: string | null }> {
  const firstLine = (await readFirstLine(filePath))?.trim();
  if (!firstLine) return { conversationId: null, projectPath: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return { conversationId: null, projectPath: null };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { conversationId: null, projectPath: null };
  }

  // Look for the payload in either `parsed.payload` or — for generic
  // JSONL writers that flatten everything onto the root — on `parsed`
  // itself. Either shape is fine.
  const rec = parsed as Record<string, unknown>;
  const payload =
    rec.payload && typeof rec.payload === 'object'
      ? (rec.payload as Record<string, unknown>)
      : rec;

  const idRaw = payload.id;
  const conversationId =
    typeof idRaw === 'string' && idRaw.length > 0 ? idRaw : null;

  let projectPath: string | null = null;
  for (const key of PROJECT_PATH_KEYS) {
    const v = payload[key];
    if (typeof v === 'string' && v.length > 0) {
      projectPath = v;
      break;
    }
  }

  return { conversationId, projectPath };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Scan a single Codex `sessions` directory and return its rollouts (untagged).
 * Missing dir → [] (Codex hasn't run for that account, or it was cleaned up).
 */
async function scanCodexSessionsDir(sessionsDir: string): Promise<Omit<CodexSessionEntry, 'accountId'>[]> {
  // A missing dir reads as an empty listing.
  const files = await collectJsonlFiles(sessionsDir);
  const entries = await mapLimit(files, FS_CONCURRENCY, async (file) => {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      // File vanished between readdir and stat — race with deletion
      // (logout, user housekeeping). Skip silently.
      return null;
    }

    const fromFile = await readFirstRecordMeta(file);
    const conversationId =
      fromFile.conversationId ?? conversationIdFromFilename(file);

    return {
      conversationId,
      projectPath: fromFile.projectPath,
      lastActivity: stat.mtime.toISOString(),
      jsonlPath: file,
    };
  });

  return entries.filter((e): e is Omit<CodexSessionEntry, 'accountId'> => e !== null);
}

export function createCodexSessionWalker(
  deps: CreateCodexSessionWalkerDeps,
): CodexSessionWalker {
  return {
    async listSessions(): Promise<CodexSessionEntry[]> {
      const all: CodexSessionEntry[] = [];
      for (const acct of deps.listCodexAccounts()) {
        const sessionsDir = path.join(acct.config_dir, 'sessions');
        for (const entry of await scanCodexSessionsDir(sessionsDir)) {
          all.push({ ...entry, accountId: acct.id });
        }
      }

      // Most-recent first across all accounts — matches the Claude
      // session-list ordering so the unified UI is consistent.
      all.sort(
        (a, b) =>
          new Date(b.lastActivity).getTime() -
          new Date(a.lastActivity).getTime(),
      );

      return all;
    },
  };
}
