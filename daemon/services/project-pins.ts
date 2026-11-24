import type { Database } from './database';

export interface ProjectPinsService {
  list(): string[];
  isPinned(projectPath: string): boolean;
  setPinned(projectPath: string, pinned: boolean): void;
}

export function createProjectPinsService(db: Database): ProjectPinsService {
  const raw = db.raw;

  const listStmt = raw.prepare(
    'SELECT project_path FROM project_pins ORDER BY project_path ASC',
  );
  const isPinnedStmt = raw.prepare(
    'SELECT 1 FROM project_pins WHERE project_path = ?',
  );
  const pinStmt = raw.prepare(
    'INSERT INTO project_pins (project_path) VALUES (?) ON CONFLICT(project_path) DO NOTHING',
  );
  const unpinStmt = raw.prepare('DELETE FROM project_pins WHERE project_path = ?');

  function list(): string[] {
    return (listStmt.all() as { project_path: string }[]).map((r) => r.project_path);
  }

  function isPinned(projectPath: string): boolean {
    return isPinnedStmt.get(projectPath) !== undefined;
  }

  function setPinned(projectPath: string, pinned: boolean): void {
    if (pinned) pinStmt.run(projectPath);
    else unpinStmt.run(projectPath);
  }

  return { list, isPinned, setPinned };
}
