import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface GitWatcherDeps {
  sendToRenderer: (channel: string, ...args: unknown[]) => void;
}

export interface GitBranchWatchStart {
  watchId: string;
  branch: string | null;
}

export interface GitWatcherService {
  start(projectPath: string): Promise<GitBranchWatchStart>;
  stop(watchId: string): void;
  disposeAll(): void;
}

interface ActiveWatch {
  watcher: fs.FSWatcher | null;
  gitdir: string | null;
  lastBranch: string | null;
  debounceTimer: NodeJS.Timeout | null;
}

const DEBOUNCE_MS = 50;

/**
 * Resolve the effective gitdir for a project path.
 *
 * - Normal repo: `<projectPath>/.git` is a directory — return that.
 * - Worktree / submodule: `<projectPath>/.git` is a file holding
 *   `gitdir: <absolute-or-relative-path>` — resolve and return the pointed-to
 *   directory.
 * - Anything else (missing, unreadable) — return null.
 */
function resolveGitdir(projectPath: string): string | null {
  const dotGit = path.join(projectPath, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }

  if (stat.isDirectory()) return dotGit;

  if (stat.isFile()) {
    try {
      const content = fs.readFileSync(dotGit, 'utf8').trim();
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (!match) return null;
      const pointed = match[1].trim();
      return path.isAbsolute(pointed) ? pointed : path.resolve(projectPath, pointed);
    } catch {
      return null;
    }
  }

  return null;
}

function readBranch(gitdir: string | null): string | null {
  if (!gitdir) return null;
  const headPath = path.join(gitdir, 'HEAD');
  let raw: string;
  try {
    raw = fs.readFileSync(headPath, 'utf8').trim();
  } catch {
    return null;
  }

  const refMatch = raw.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (refMatch) return refMatch[1].trim();

  // Detached HEAD — raw SHA. Show the short form so the badge stays compact.
  if (/^[0-9a-f]{7,40}$/i.test(raw)) return raw.slice(0, 7);

  return null;
}

export function createGitWatcherService(deps: GitWatcherDeps): GitWatcherService {
  const active = new Map<string, ActiveWatch>();

  function emit(watchId: string, branch: string | null): void {
    deps.sendToRenderer(`git-branch-changed:${watchId}`, { branch });
  }

  return {
    async start(projectPath) {
      const watchId = crypto.randomUUID();
      const gitdir = resolveGitdir(projectPath);
      const initialBranch = readBranch(gitdir);

      const state: ActiveWatch = {
        watcher: null,
        gitdir,
        lastBranch: initialBranch,
        debounceTimer: null,
      };

      if (gitdir) {
        // Watch the gitdir rather than HEAD itself. Git rewrites HEAD by
        // writing a new file and renaming, which can orphan a file-level
        // fs.watch on some platforms; directory watchers survive atomic
        // replaces and fire on the rename.
        try {
          state.watcher = fs.watch(gitdir, { persistent: false }, (_event, filename) => {
            if (filename && filename !== 'HEAD') return;
            if (state.debounceTimer) clearTimeout(state.debounceTimer);
            state.debounceTimer = setTimeout(() => {
              const next = readBranch(state.gitdir);
              if (next !== state.lastBranch) {
                state.lastBranch = next;
                emit(watchId, next);
              }
            }, DEBOUNCE_MS);
          });
          state.watcher.on('error', (err) => {
            console.error('[git-watcher] watch error:', err);
          });
        } catch (err) {
          console.error('[git-watcher] failed to watch gitdir:', err);
        }
      }

      active.set(watchId, state);
      return { watchId, branch: initialBranch };
    },

    stop(watchId) {
      const state = active.get(watchId);
      if (!state) return;
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      if (state.watcher) {
        try {
          state.watcher.close();
        } catch {
          // best effort
        }
      }
      active.delete(watchId);
    },

    disposeAll() {
      for (const id of Array.from(active.keys())) this.stop(id);
    },
  };
}
