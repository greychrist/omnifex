import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export interface GitWatcherDeps {
  sendToRenderer: (channel: string, ...args: unknown[]) => void;
  /** Working-tree poll interval (ms). Defaults to 3000. */
  pollIntervalMs?: number;
}

export interface GitBranchWatchStart {
  watchId: string;
  branch: string | null;
  changed: number;
  untracked: number;
}

export interface GitWatcherService {
  start(projectPath: string): Promise<GitBranchWatchStart>;
  stop(watchId: string): void;
  disposeAll(): void;
}

interface ActiveWatch {
  projectPath: string;
  watcher: fs.FSWatcher | null;
  gitdir: string | null;
  lastBranch: string | null;
  lastChanged: number;
  lastUntracked: number;
  debounceTimer: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
}

const DEBOUNCE_MS = 50;
const DEFAULT_POLL_MS = 3000;

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

  if (/^[0-9a-f]{7,40}$/i.test(raw)) return raw.slice(0, 7);

  return null;
}

interface StatusCounts {
  changed: number;
  untracked: number;
}

function parsePorcelainV1Z(buf: string): StatusCounts {
  // -z output: each entry is `XY <path>\0`. For renames/copies (R/C) the
  // entry is followed by an additional `<orig-path>\0` field that must be
  // skipped so the next status pair is read from the right offset.
  let changed = 0;
  let untracked = 0;
  const tokens = buf.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!tok) { i++; continue; }
    if (tok.length < 3) { i++; continue; }
    const xy = tok.slice(0, 2);
    if (xy === '??') untracked++;
    else if (xy !== '!!') changed++;
    if (xy[0] === 'R' || xy[0] === 'C') i += 2;
    else i += 1;
  }
  return { changed, untracked };
}

function readStatusCounts(projectPath: string, gitdir: string | null): Promise<StatusCounts> {
  if (!gitdir) return Promise.resolve({ changed: 0, untracked: 0 });
  return new Promise((resolve) => {
    execFile(
      'git',
      ['status', '--porcelain=v1', '-z', '--ignore-submodules=dirty'],
      { cwd: projectPath, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve({ changed: 0, untracked: 0 });
          return;
        }
        resolve(parsePorcelainV1Z(stdout));
      },
    );
  });
}

export function createGitWatcherService(deps: GitWatcherDeps): GitWatcherService {
  const active = new Map<string, ActiveWatch>();
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;

  function emit(watchId: string, state: ActiveWatch): void {
    deps.sendToRenderer(`git-branch-changed:${watchId}`, {
      branch: state.lastBranch,
      changed: state.lastChanged,
      untracked: state.lastUntracked,
    });
  }

  async function refresh(watchId: string, state: ActiveWatch): Promise<void> {
    const nextBranch = readBranch(state.gitdir);
    const { changed, untracked } = await readStatusCounts(state.projectPath, state.gitdir);
    if (
      nextBranch !== state.lastBranch ||
      changed !== state.lastChanged ||
      untracked !== state.lastUntracked
    ) {
      state.lastBranch = nextBranch;
      state.lastChanged = changed;
      state.lastUntracked = untracked;
      emit(watchId, state);
    }
  }

  return {
    async start(projectPath) {
      const watchId = crypto.randomUUID();
      const gitdir = resolveGitdir(projectPath);
      const initialBranch = readBranch(gitdir);
      const { changed, untracked } = await readStatusCounts(projectPath, gitdir);

      const state: ActiveWatch = {
        projectPath,
        watcher: null,
        gitdir,
        lastBranch: initialBranch,
        lastChanged: changed,
        lastUntracked: untracked,
        debounceTimer: null,
        pollTimer: null,
      };

      if (gitdir) {
        try {
          state.watcher = fs.watch(gitdir, { persistent: false }, (_event, filename) => {
            // HEAD changes for branch switches; index changes for staged
            // edits. Both should trigger a recount.
            if (filename && filename !== 'HEAD' && filename !== 'index') return;
            if (state.debounceTimer) clearTimeout(state.debounceTimer);
            state.debounceTimer = setTimeout(() => {
              void refresh(watchId, state);
            }, DEBOUNCE_MS);
          });
          state.watcher.on('error', (err) => {
            console.error('[git-watcher] watch error:', err);
          });
        } catch (err) {
          console.error('[git-watcher] failed to watch gitdir:', err);
        }

        // Working-tree edits don't touch .git/, so poll on an interval to
        // pick up untracked-file creation and unstaged modifications.
        state.pollTimer = setInterval(() => {
          void refresh(watchId, state);
        }, pollIntervalMs);
        if (typeof state.pollTimer.unref === 'function') state.pollTimer.unref();
      }

      active.set(watchId, state);
      return { watchId, branch: initialBranch, changed, untracked };
    },

    stop(watchId) {
      const state = active.get(watchId);
      if (!state) return;
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      if (state.pollTimer) clearInterval(state.pollTimer);
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
