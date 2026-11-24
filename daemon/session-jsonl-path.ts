// Never assume `~/.claude`: the root is always some account's `config_dir`; an unresolvable project returns null.

import fs from 'node:fs';
import path from 'node:path';
import { encodeProjectId } from './services/project-paths';

export interface SessionJsonlPathDeps {
  listAccounts(): { config_dir: string }[];
  /** Never a default. */
  resolveConfigDir(projectPath: string): string | null | undefined;
}

export type SessionJsonlPathResolver = (
  sessionUuid: string,
  projectPath: string,
  configDir: string | null | undefined,
) => string | null;

/** Falls back to every project dir in the account (renames, worktree relocation); never another account. */
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

// `--resume` on an id with no JSONL makes the CLI exit; search account-wide because EnterWorktree moves the transcript.
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
    // Use encodeProjectId: a slash-only encoding missed paths with dots, underscores or spaces.
    const projectId = encodeProjectId(projectPath);

    const tryAt = (cfgDir: string): string | null =>
      findSessionJsonlInAccount(cfgDir, sessionUuid, projectPath);

    if (configDir) {
      const found = tryAt(configDir);
      if (found) return found;
    }

    const seen = new Set<string>(configDir ? [configDir] : []);
    for (const acct of deps.listAccounts()) {
      if (seen.has(acct.config_dir)) continue;
      seen.add(acct.config_dir);
      const found = tryAt(acct.config_dir);
      if (found) return found;
    }

    // No synthetic ~/.claude and no first-account fallback.
    const resolvedRoot = configDir ?? deps.resolveConfigDir(projectPath);
    if (!resolvedRoot) return null;
    return path.join(resolvedRoot, 'projects', projectId, `${sessionUuid}.jsonl`);
  };
}
