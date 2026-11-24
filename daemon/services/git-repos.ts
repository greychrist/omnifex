/** A repo's identity is its main checkout, so per-repo settings follow the repo. No `git` spawn; never on the status poll. */
import fs from 'node:fs';
import path from 'node:path';

export const MAX_DISCOVERED_REPOS = 50;
export const MIN_SCAN_DEPTH = 1;
export const MAX_SCAN_DEPTH = 5;
export const DEFAULT_SCAN_DEPTH = 1;

export interface DiscoveredRepo {
  path: string;
  name: string;
}

export interface DiscoveryResult {
  rootIsRepo: boolean;
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

  const byIdentity = new Map<string, DiscoveredRepo>();
  for (const repo of found) {
    const id = repoIdentity(repo.path) ?? repo.path;
    if (id === root && rootIsRepo) continue;
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
