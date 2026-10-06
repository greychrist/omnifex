/**
 * Where a session's JSONL transcript lives, searched across accounts.
 *
 * One module, two composition roots — `electron/main.ts` and
 * `electron/remote/daemon.ts` both build a `SessionsSummaryService` and both
 * carried their own copy of this. They agreed, but only by hand: one hoisted
 * `projectsDir` where the other inlined it, one wrote `import('fs').Dirent`
 * and the other `fs.Dirent`. Cosmetic differences are the evidence that the
 * next fix to one would not reach the other.
 *
 * What it must never do is assume `~/.claude`. The root is always some
 * account's `config_dir`; an unresolvable project returns null so the caller's
 * no-account branch fires. See CLAUDE.md "Multi-Account Rules".
 */

import fs from 'node:fs';
import path from 'node:path';
import { encodeProjectId } from './services/project-paths';

export interface SessionJsonlPathDeps {
  listAccounts(): { config_dir: string }[];
  /** The account a project resolves to, or null. Never a default. */
  resolveConfigDir(projectPath: string): string | null | undefined;
}

export type SessionJsonlPathResolver = (
  sessionUuid: string,
  projectPath: string,
  configDir: string | null | undefined,
) => string | null;

/**
 * A session's transcript under one account, or null. The encoded project
 * directory first, then any project directory in the account: that covers a
 * renamed project, and a transcript the CLI moved into a worktree's project
 * directory when the session entered the worktree. Never another account.
 */
export function findSessionJsonlInAccount(
  configDir: string,
  sessionUuid: string,
  projectPath: string,
): string | null {
  const projectsDir = path.join(configDir, 'projects');
  const encoded = path.join(projectsDir, encodeProjectId(projectPath), `${sessionUuid}.jsonl`);
  if (fs.existsSync(encoded)) return encoded;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projectsDir, entry.name, `${sessionUuid}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Has the CLI written a transcript for this session id yet?
 *
 * Two separate paths spawn the CLI against an existing session id — cold
 * start with `resumeSessionId` (reconnect / restart) and `restartQuery` after
 * a stream death. Both must answer the same question first, because
 * `--resume` against an id with no JSONL makes the CLI print "No conversation
 * found with session ID …" and exit. Passing `--session-id` instead keeps the
 * id and starts a fresh transcript.
 *
 * Account-wide, not just the project's own directory: after `EnterWorktree`
 * the transcript lives in the worktree's project directory, and the CLI's
 * `--resume <id>` finds it there from the original cwd and keeps appending to
 * it. Answering "no" sent `--session-id` — a blank conversation under the
 * same id, the history orphaned in the worktree directory.
 *
 * One function, so a third resume path cannot quietly forget the check —
 * that is exactly how the second one shipped.
 */
export function hasTranscript(
  configDir: string,
  projectPath: string,
  sessionId: string,
): boolean {
  return findSessionJsonlInAccount(configDir, sessionId, projectPath) !== null;
}

export function createSessionJsonlPathResolver(
  deps: SessionJsonlPathDeps,
): SessionJsonlPathResolver {
  return (sessionUuid, projectPath, configDir) => {
    // The caller normally knows the account: the renderer holds it at tab
    // level (chat tab via accountResolution, SessionList via
    // resolveAccountForProject), and lifecycle.ts passes the SessionHandle's
    // configDir on the close path. Scanning every account is the fallback for
    // the rare case where nobody knows yet.

    // Claude Code encodes project paths to directory names by replacing every
    // non-alphanumeric character with '-'. Shared with the rest of the app
    // rather than re-derived here: the old inline slash-only form missed any
    // path with a dot, underscore or space, which silently pushed those
    // sessions onto the rename-tolerant scan below.
    const projectId = encodeProjectId(projectPath);

    const tryAt = (cfgDir: string): string | null =>
      findSessionJsonlInAccount(cfgDir, sessionUuid, projectPath);

    if (configDir) {
      const found = tryAt(configDir);
      if (found) return found;
    }

    // The caller gave no configDir, or the session truly isn't in that
    // account. Search every known account, skipping the one already tried.
    const seen = new Set<string>(configDir ? [configDir] : []);
    for (const acct of deps.listAccounts()) {
      if (seen.has(acct.config_dir)) continue;
      seen.add(acct.config_dir);
      const found = tryAt(acct.config_dir);
      if (found) return found;
    }

    // Nothing on disk. Answer with where it WOULD go under the account that
    // owns it, and null when no account does — there is no synthetic
    // ~/.claude fallback and no "first account". See CLAUDE.md
    // "Multi-Account Rules" and NoAccountError in claude.ts.
    const resolvedRoot = configDir ?? deps.resolveConfigDir(projectPath);
    if (!resolvedRoot) return null;
    return path.join(resolvedRoot, 'projects', projectId, `${sessionUuid}.jsonl`);
  };
}
