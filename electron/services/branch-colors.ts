import type { Database } from './database';
import { repoIdentity } from './git-repos';

/**
 * Branch color pins, per repo. A repo is keyed by its main checkout
 * (`repoIdentity`), so the same repo shows the same colors whether it is
 * opened directly, through a linked worktree, or inside another project.
 */
export interface BranchColor {
  id: number;
  repo_path: string;
  branch_name: string;
  color: string;
  sort_order: number;
  created_at: number;
}

export interface BranchColorUpsert {
  /** Any checkout of the repo; normalised to its main checkout. */
  repo_path: string;
  branch_name: string;
  color: string;
}

export interface BranchColorsService {
  listForRepo(repoPath: string): BranchColor[];
  upsert(input: BranchColorUpsert): BranchColor;
  delete(id: number): boolean;
}

export interface BranchColorsDeps {
  /** Announces `branch-colors-changed` `{ repoPath }` after every write. */
  sendToRenderer?: (channel: string, ...args: unknown[]) => void;
}

const COLUMNS = 'id, repo_path, branch_name, color, sort_order, created_at';

export function createBranchColorsService(db: Database, deps: BranchColorsDeps = {}): BranchColorsService {
  const raw = db.raw;
  const key = (p: string): string => repoIdentity(p) ?? p;
  const announce = (repoPath: string): void => {
    deps.sendToRenderer?.('branch-colors-changed', { repoPath });
  };

  const listStmt = raw.prepare(
    `SELECT ${COLUMNS} FROM repo_branch_colors WHERE repo_path = ? ORDER BY sort_order ASC, id ASC`,
  );
  const nextOrderStmt = raw.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM repo_branch_colors WHERE repo_path = ?`,
  );
  const upsertStmt = raw.prepare(
    `INSERT INTO repo_branch_colors (repo_path, branch_name, color, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(repo_path, branch_name)
     DO UPDATE SET color = excluded.color
     RETURNING ${COLUMNS}`,
  );
  const deleteStmt = raw.prepare(`DELETE FROM repo_branch_colors WHERE id = ? RETURNING repo_path`);

  return {
    listForRepo(repoPath) {
      return listStmt.all(key(repoPath)) as BranchColor[];
    },

    upsert(input) {
      const repoPath = key(input.repo_path);
      const { next } = nextOrderStmt.get(repoPath) as { next: number };
      const row = upsertStmt.get(repoPath, input.branch_name, input.color, next, Date.now()) as BranchColor;
      announce(repoPath);
      return row;
    },

    delete(id) {
      const row = deleteStmt.get(id) as { repo_path: string } | undefined;
      if (!row) return false;
      announce(row.repo_path);
      return true;
    },
  };
}
