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
 * throwing). Sync — the directory tree is tiny in practice and we want a
 * single deterministic ordering before sorting by mtime.
 */
function collectJsonlFiles(rootDir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(rootDir, ent.name);
    if (ent.isDirectory()) {
      out.push(...collectJsonlFiles(full));
    } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
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
function readFirstRecordMeta(
  filePath: string,
): { conversationId: string | null; projectPath: string | null } {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { conversationId: null, projectPath: null };
  }
  const firstLine = content.split('\n', 1)[0]?.trim();
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
function scanCodexSessionsDir(sessionsDir: string): Omit<CodexSessionEntry, 'accountId'>[] {
  if (!fs.existsSync(sessionsDir)) return [];

  const files = collectJsonlFiles(sessionsDir);
  const entries: Omit<CodexSessionEntry, 'accountId'>[] = [];

  for (const file of files) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      // File vanished between readdir and stat — race with deletion
      // (logout, user housekeeping). Skip silently.
      continue;
    }

    const fromFile = readFirstRecordMeta(file);
    const conversationId =
      fromFile.conversationId ?? conversationIdFromFilename(file);

    entries.push({
      conversationId,
      projectPath: fromFile.projectPath,
      lastActivity: stat.mtime.toISOString(),
      jsonlPath: file,
    });
  }

  return entries;
}

export function createCodexSessionWalker(
  deps: CreateCodexSessionWalkerDeps,
): CodexSessionWalker {
  return {
    async listSessions(): Promise<CodexSessionEntry[]> {
      const all: CodexSessionEntry[] = [];
      for (const acct of deps.listCodexAccounts()) {
        const sessionsDir = path.join(acct.config_dir, 'sessions');
        for (const entry of scanCodexSessionsDir(sessionsDir)) {
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
