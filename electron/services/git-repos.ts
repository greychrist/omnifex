/**
 * Finding the git repositories inside a project folder, and naming each one.
 *
 * A repo's *identity* is its main checkout: every linked worktree of a repo
 * resolves to the same path, so per-repo settings (branch colors, watch
 * selections) follow the repo rather than whichever checkout opened it.
 *
 * Pure filesystem — no `git` spawn. Discovery runs when a session's git watch
 * starts and when the repos dialog opens, never on the status poll.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MAX_DISCOVERED_REPOS = 50;
export const MIN_SCAN_DEPTH = 1;
export const MAX_SCAN_DEPTH = 5;
export const DEFAULT_SCAN_DEPTH = 1;

export interface DiscoveredRepo {
  /** Realpath of the checkout directory. */
  path: string;
  /** Path relative to the project folder, `/`-separated. */
  name: string;
}

export interface DiscoveryResult {
  rootIsRepo: boolean;
  /** Repos below the project folder, the folder itself excluded. */
  repos: DiscoveredRepo[];
  truncated: boolean;
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** The repo's git dir for a checkout at `dir`, or null when `dir` is not one. */
function gitdirOf(dir: string): string | null {
  const dotGit = path.join(dir, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return null;
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    const pointed = m[1].trim();
    return path.isAbsolute(pointed) ? pointed : path.resolve(dir, pointed);
  } catch {
    return null;
  }
}

/**
 * The main checkout of the repo whose checkout is `dir`, realpath-resolved.
 * Null when `dir` is not the top level of a checkout.
 */
export function repoIdentity(dir: string): string | null {
  const gitdir = gitdirOf(dir);
  if (!gitdir) return null;
  let commondir: string | null = null;
  try {
    const raw = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim();
    if (raw) commondir = path.isAbsolute(raw) ? raw : path.resolve(gitdir, raw);
  } catch {
    // No commondir file: `dir` is a main checkout (or a submodule).
  }
  if (commondir) return realpathOr(path.dirname(commondir));
  return realpathOr(dir);
}

export function isRepoDir(dir: string): boolean {
  return gitdirOf(dir) !== null;
}

export function clampScanDepth(depth: number): number {
  if (!Number.isFinite(depth)) return DEFAULT_SCAN_DEPTH;
  return Math.min(MAX_SCAN_DEPTH, Math.max(MIN_SCAN_DEPTH, Math.round(depth)));
}

/**
 * Breadth-first walk from `projectPath` (depth 0) down to `depth`. The root
 * being a repo does not stop the walk; below it, a repo is reported and not
 * descended into. Hidden dirs, `node_modules` and symlinks are skipped. A
 * linked worktree of a repo already found is folded into that repo.
 */
export async function discoverRepos(projectPath: string, depth: number): Promise<DiscoveryResult> {
  const root = realpathOr(projectPath);
  const rootIsRepo = isRepoDir(root);
  const found: DiscoveredRepo[] = [];
  let level: string[] = [root];

  for (let d = 1; d <= depth && level.length > 0; d++) {
    const next: string[] = [];
    for (const dir of level) {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (!e.isDirectory() || e.isSymbolicLink()) continue;
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const child = path.join(dir, e.name);
        if (isRepoDir(child)) {
          found.push({ path: child, name: path.relative(root, child).split(path.sep).join('/') });
        } else {
          next.push(child);
        }
      }
    }
    level = next;
  }

  // One entry per repo identity, preferring the main checkout itself.
  const byIdentity = new Map<string, DiscoveredRepo>();
  for (const repo of found) {
    const id = repoIdentity(repo.path) ?? repo.path;
    if (id === root && rootIsRepo) continue; // a worktree of the root repo
    const prev = byIdentity.get(id);
    if (!prev || (prev.path !== id && repo.path === id)) byIdentity.set(id, repo);
  }
  const repos = Array.from(byIdentity.values()).sort((a, b) => a.name.localeCompare(b.name));
  return {
    rootIsRepo,
    repos: repos.slice(0, MAX_DISCOVERED_REPOS),
    truncated: repos.length > MAX_DISCOVERED_REPOS,
  };
}
