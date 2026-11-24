import type { Database } from './database';
import { repoIdentity } from './git-repos';

/** Keyed by the repo's main checkout (`repoIdentity`), so a repo reads the same everywhere. */
export interface RepoAliasesService {
  list(repoPaths: string[]): Record<string, string>;
  set(repoPath: string, alias: string): void;
}

export interface RepoAliasesDeps {
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
