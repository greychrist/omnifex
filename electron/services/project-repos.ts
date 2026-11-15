/**
 * Which git repos a project's sessions watch.
 *
 * A project folder may be a repo, contain repos, or both. Discovery
 * (`git-repos.ts`) finds them; this service remembers the user's choices —
 * scan depth and the repos they turned on — per project, so every session in
 * the project shows the same repos. Nothing is watched until the user says so,
 * except the project folder itself when it is a repo.
 */
import type { Database } from './database';
import {
  clampScanDepth,
  DEFAULT_SCAN_DEPTH,
  isRepoDir,
  repoIdentity,
  type DiscoveryResult,
} from './git-repos';
import fs from 'node:fs';
import path from 'node:path';

export interface ProjectRepo {
  path: string;
  /** Relative to the project folder, `/`-separated. */
  name: string;
  watched: boolean;
  /** Saved as watched but no longer a repo on disk. */
  missing: boolean;
}

export interface ProjectRepos {
  scanDepth: number;
  rootIsRepo: boolean;
  /** Realpath of the project folder. */
  rootPath: string;
  repos: ProjectRepo[];
  truncated: boolean;
}

export interface WatchedRepo {
  path: string;
  /** '' for the project folder itself. */
  name: string;
}

export interface ProjectReposService {
  get(projectPath: string): Promise<ProjectRepos>;
  setWatched(projectPath: string, repoPath: string, watched: boolean): void;
  setScanDepth(projectPath: string, depth: number): void;
  remove(projectPath: string, repoPath: string): void;
  /** DB only, no discovery: the root first when it is a repo, then watched repos still on disk. */
  watchedRepos(projectPath: string): WatchedRepo[];
  /** Discovered repos not watched. */
  foundCount(projectPath: string): Promise<number>;
  onChange(listener: (projectPath: string) => void): () => void;
}

export interface ProjectReposDeps {
  db: Database;
  discover: (projectPath: string, depth: number) => Promise<DiscoveryResult>;
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function relName(root: string, p: string): string {
  return path.relative(root, p).split(path.sep).join('/');
}

export function createProjectReposService(deps: ProjectReposDeps): ProjectReposService {
  const raw = deps.db.raw;
  const listeners = new Set<(projectPath: string) => void>();

  const depthStmt = raw.prepare('SELECT scan_depth FROM project_git_settings WHERE project_path = ?');
  const setDepthStmt = raw.prepare(
    `INSERT INTO project_git_settings (project_path, scan_depth) VALUES (?, ?)
     ON CONFLICT(project_path) DO UPDATE SET scan_depth = excluded.scan_depth`,
  );
  const rowsStmt = raw.prepare('SELECT repo_path, watched FROM project_git_repos WHERE project_path = ?');
  const setWatchedStmt = raw.prepare(
    `INSERT INTO project_git_repos (project_path, repo_path, watched) VALUES (?, ?, ?)
     ON CONFLICT(project_path, repo_path) DO UPDATE SET watched = excluded.watched`,
  );
  const removeStmt = raw.prepare('DELETE FROM project_git_repos WHERE project_path = ? AND repo_path = ?');

  // Projects are keyed by the path the caller uses (the same key every other
  // per-project table uses); repo paths are realpaths.
  const scanDepth = (projectPath: string): number => {
    const row = depthStmt.get(projectPath) as { scan_depth: number } | undefined;
    return row ? clampScanDepth(row.scan_depth) : DEFAULT_SCAN_DEPTH;
  };
  const savedRows = (projectPath: string): Map<string, boolean> =>
    new Map((rowsStmt.all(projectPath) as { repo_path: string; watched: number }[])
      .map((r) => [r.repo_path, r.watched === 1]));
  const notify = (projectPath: string): void => {
    for (const l of listeners) {
      try { l(projectPath); } catch (err) { console.error('[project-repos] listener failed:', err); }
    }
  };

  return {
    async get(projectPath) {
      const depth = scanDepth(projectPath);
      const rootPath = realpathOr(projectPath);
      const found = await deps.discover(projectPath, depth);
      const saved = savedRows(projectPath);
      const repos: ProjectRepo[] = found.repos.map((r) => ({
        path: r.path,
        name: r.name,
        watched: saved.get(r.path) === true,
        missing: false,
      }));
      const listed = new Set(repos.map((r) => r.path));
      for (const [p, watched] of saved) {
        if (!watched || listed.has(p)) continue;
        repos.push({ path: p, name: relName(rootPath, p), watched, missing: !isRepoDir(p) });
      }
      repos.sort((a, b) => a.name.localeCompare(b.name));
      return { scanDepth: depth, rootIsRepo: found.rootIsRepo, rootPath, repos, truncated: found.truncated };
    },

    setWatched(projectPath, repoPath, watched) {
      setWatchedStmt.run(projectPath, realpathOr(repoPath), watched ? 1 : 0);
      notify(projectPath);
    },

    setScanDepth(projectPath, depth) {
      setDepthStmt.run(projectPath, clampScanDepth(depth));
      notify(projectPath);
    },

    remove(projectPath, repoPath) {
      removeStmt.run(projectPath, repoPath);
      notify(projectPath);
    },

    watchedRepos(projectPath) {
      const rootPath = realpathOr(projectPath);
      const out: WatchedRepo[] = [];
      if (repoIdentity(rootPath)) out.push({ path: rootPath, name: '' });
      const subs: WatchedRepo[] = [];
      for (const [p, watched] of savedRows(projectPath)) {
        if (watched && p !== rootPath && isRepoDir(p)) subs.push({ path: p, name: relName(rootPath, p) });
      }
      subs.sort((a, b) => a.name.localeCompare(b.name));
      return [...out, ...subs];
    },

    async foundCount(projectPath) {
      const found = await deps.discover(projectPath, scanDepth(projectPath));
      const saved = savedRows(projectPath);
      return found.repos.filter((r) => saved.get(r.path) !== true).length;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
