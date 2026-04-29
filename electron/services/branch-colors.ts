import type { Database } from './database';

export interface BranchColor {
  id: number;
  project_path: string;
  branch_name: string;
  color: string;
  sort_order: number;
  created_at: number;
}

export interface BranchColorUpsert {
  project_path: string;
  branch_name: string;
  color: string;
}

export interface BranchColorsService {
  listForProject(projectPath: string): BranchColor[];
  upsert(input: BranchColorUpsert): BranchColor;
  delete(id: number): boolean;
}

export function createBranchColorsService(db: Database): BranchColorsService {
  const raw = db.raw;

  const listStmt = raw.prepare(
    `SELECT id, project_path, branch_name, color, sort_order, created_at
       FROM branch_colors
      WHERE project_path = ?
      ORDER BY sort_order ASC, id ASC`,
  );

  const upsertStmt = raw.prepare(
    `INSERT INTO branch_colors (project_path, branch_name, color, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_path, branch_name)
     DO UPDATE SET color = excluded.color
     RETURNING id, project_path, branch_name, color, sort_order, created_at`,
  );

  const deleteStmt = raw.prepare(`DELETE FROM branch_colors WHERE id = ?`);

  return {
    listForProject(projectPath: string): BranchColor[] {
      return listStmt.all(projectPath) as BranchColor[];
    },

    upsert(input: BranchColorUpsert): BranchColor {
      const now = Date.now();
      const nextOrderRow = raw
        .prepare(
          `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM branch_colors WHERE project_path = ?`,
        )
        .get(input.project_path) as { next: number };
      const row = upsertStmt.get(
        input.project_path,
        input.branch_name,
        input.color,
        nextOrderRow.next,
        now,
      ) as BranchColor;
      return row;
    },

    delete(id: number): boolean {
      const info = deleteStmt.run(id);
      return info.changes > 0;
    },
  };
}
