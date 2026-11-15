import type { Database } from './database';
import { repoIdentity } from './git-repos';

/**
 * A short display name per repo, shown on the git bar in place of its folder
 * name. Keyed by the repo's main checkout (`repoIdentity`), like branch
 * colors, so a repo reads the same in every project, session and worktree.
 */
export interface RepoAliasesService {
  /** Aliases for the paths asked for, keyed by those paths; repos without one are absent. */
  list(repoPaths: string[]): Record<string, string>;
  /** Set a repo's alias; blank clears it. Any checkout path of the repo works. */
  set(repoPath: string, alias: string): void;
}

export interface RepoAliasesDeps {
  /** Announces `repo-aliases-changed` `{ repoPath }` after every write. */
  sendToRenderer?: (channel: string, ...args: unknown[]) => void;
}

export function createRepoAliasesService(db: Database, deps: RepoAliasesDeps = {}): RepoAliasesService {
  const raw = db.raw;
  const key = (p: string): string => repoIdentity(p) ?? p;
  const getStmt = raw.prepare('SELECT alias FROM repo_aliases WHERE repo_path = ?');
  const setStmt = raw.prepare(
    `INSERT INTO repo_aliases (repo_path, alias) VALUES (?, ?)
     ON CONFLICT(repo_path) DO UPDATE SET alias = excluded.alias`,
  );
  const clearStmt = raw.prepare('DELETE FROM repo_aliases WHERE repo_path = ?');

  return {
    list(repoPaths) {
      const out: Record<string, string> = {};
      for (const p of repoPaths) {
        const row = getStmt.get(key(p)) as { alias: string } | undefined;
        if (row) out[p] = row.alias;
      }
      return out;
    },

    set(repoPath, alias) {
      const k = key(repoPath);
      const trimmed = alias.trim();
      if (trimmed) setStmt.run(k, trimmed);
      else clearStmt.run(k);
      deps.sendToRenderer?.('repo-aliases-changed', { repoPath: k });
    },
  };
}
