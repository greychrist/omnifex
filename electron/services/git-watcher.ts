import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export interface GitWatcherDeps {
  sendToRenderer: (channel: string, ...args: unknown[]) => void;
  /** Working-tree poll interval (ms). Defaults to 3000. */
  pollIntervalMs?: number;
}

export interface WorktreeInfo {
  /** Absolute, real-path-resolved worktree directory. */
  path: string;
  /** Short branch name, or null if the worktree has a detached HEAD. */
  branch: string | null;
}

/**
 * Enumerate worktrees attached to the same repository as `projectPath`,
 * excluding `projectPath` itself. Returns [] for non-git directories or when
 * `git worktree list` fails. Paths are normalized through `realpath` so the
 * caller-side filter survives macOS `/private/var` ↔ `/var` symlink quirks.
 */
export async function listWorktrees(projectPath: string): Promise<WorktreeInfo[]> {
  if (!resolveGitdir(projectPath)) return [];

  let selfReal: string;
  try {
    selfReal = fs.realpathSync(projectPath);
  } catch {
    selfReal = projectPath;
  }

  return new Promise((resolve) => {
    execFile(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd: projectPath, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        resolve(parseWorktreePorcelain(stdout, selfReal));
      },
    );
  });
}

function parseWorktreePorcelain(buf: string, selfReal: string): WorktreeInfo[] {
  // Records are separated by blank lines. Each record has at least a
  // `worktree <path>` header; branch info is either `branch refs/heads/<name>`,
  // `detached`, or absent (bare repo entry).
  const out: WorktreeInfo[] = [];
  for (const block of buf.split(/\r?\n\r?\n/)) {
    let wtPath: string | null = null;
    let branch: string | null = null;
    let detached = false;
    let bare = false;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length).trim();
      else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        const m = /^refs\/heads\/(.+)$/.exec(ref);
        branch = m ? m[1] : ref;
      } else if (line === 'detached') detached = true;
      else if (line === 'bare') bare = true;
    }
    if (!wtPath || bare) continue;
    let real: string;
    try {
      real = fs.realpathSync(wtPath);
    } catch {
      real = wtPath;
    }
    if (real === selfReal) continue;
    out.push({ path: real, branch: detached ? null : branch });
  }
  return out;
}

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
      const match = /^gitdir:\s*(.+)$/m.exec(content);
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

  const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(raw);
  if (refMatch) return refMatch[1].trim();

  if (/^[0-9a-f]{7,40}$/i.test(raw)) return raw.slice(0, 7);

  return null;
}

interface StatusCounts {
  changed: number;
  untracked: number;
}

interface StatusReadResult extends StatusCounts {
  error: string | null;
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
    if (xy.startsWith('R') || xy.startsWith('C')) i += 2;
    else i += 1;
  }
  return { changed, untracked };
}

function readStatusCounts(
  projectPath: string,
  gitdir: string | null,
  timeoutMs?: number,
): Promise<StatusReadResult> {
  if (!gitdir) return Promise.resolve({ changed: 0, untracked: 0, error: null });
  return new Promise((resolve) => {
    execFile(
      'git',
      ['status', '--porcelain=v1', '-z', '--ignore-submodules=dirty'],
      {
        cwd: projectPath,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        ...(timeoutMs ? { timeout: timeoutMs } : {}),
      },
      (err, stdout, stderr) => {
        if (err) {
          // Prefer git's own stderr message — `git status` writes a
          // human-readable explanation there for things like "not a git
          // repository" or a corrupt index. A killed-by-timeout error has
          // `err.killed === true` and an empty stderr; surface that case
          // explicitly so the user knows the read was abandoned.
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
          const msg = killed
            ? `git status timed out after ${timeoutMs}ms`
            : (stderr && stderr.toString().trim()) || (err.message || 'git status failed');
          resolve({ changed: 0, untracked: 0, error: msg });
          return;
        }
        const counts = parsePorcelainV1Z(stdout);
        resolve({ ...counts, error: null });
      },
    );
  });
}

function resolveCommondir(projectPath: string, gitdir: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['rev-parse', '--git-common-dir'],
      { cwd: projectPath, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(gitdir);
          return;
        }
        const cd = stdout.toString().trim();
        if (!cd) {
          resolve(gitdir);
          return;
        }
        resolve(path.isAbsolute(cd) ? cd : path.resolve(projectPath, cd));
      },
    );
  });
}


// ---------------------------------------------------------------------------
// SessionGitWatcher — one watcher per session tab. Replaces N per-peer
// `start()` watches plus the standalone `startWorktreeListWatch`. Exposes a
// single event channel `session-git-changed:<watchId>` carrying the full
// {project, worktrees[]} snapshot whenever anything observable changes.
// ---------------------------------------------------------------------------

export interface PathSnapshot {
  path: string;
  branch: string | null;
  changed: number;
  untracked: number;
  error: string | null;
}

export interface SessionGitSnapshot {
  project: PathSnapshot;
  /** Sibling worktrees, sorted by path. */
  worktrees: PathSnapshot[];
}

export interface SessionGitWatcherService {
  start(projectPath: string): Promise<{ watchId: string; snapshot: SessionGitSnapshot }>;
  reconnect(watchId: string): Promise<SessionGitSnapshot | null>;
  stop(watchId: string): void;
  disposeAll(): void;
}

interface ActiveSessionWatch {
  projectPath: string;
  /** Resolved gitdir per path (project + each peer). */
  gitdirs: Map<string, string>;
  /** fs.watch on each gitdir for HEAD/index. */
  gitdirWatchers: Map<string, fs.FSWatcher>;
  /** Watcher on the shared commondir (so we notice `worktrees/` being created). */
  commondirWatcher: fs.FSWatcher | null;
  /** Watcher on `<commondir>/worktrees/` for peer add/remove. */
  worktreesDirWatcher: fs.FSWatcher | null;
  /** Resolved commondir for this watch (constant for the project's lifetime). */
  commondir: string | null;
  /** Branch hint per path from `git worktree list` — used as a fallback. */
  branchHints: Map<string, string | null>;
  /** Last emitted snapshot, kept so we can diff and skip no-op emits. */
  last: SessionGitSnapshot;
  pollTimer: NodeJS.Timeout | null;
  refreshDebounceTimer: NodeJS.Timeout | null;
  /** Per-`git status` timeout — caps any single peer's stall. */
  readTimeoutMs: number;
  /** Whether refresh() is currently running (in-flight guard). */
  refreshing: boolean;
  /** Set true while a refresh is running and a new trigger arrives — re-runs once current finishes. */
  refreshAgain: boolean;
}

export interface SessionGitWatcherDeps extends GitWatcherDeps {
  /** Per-`git status` timeout in ms. Defaults to 5000. */
  readTimeoutMs?: number;
}

/** Per-path read with timeout + try/catch — never throws, always returns a PathSnapshot. */
async function readPathSnapshot(
  p: string,
  gitdir: string | null,
  branchHint: string | null,
  timeoutMs: number,
): Promise<PathSnapshot> {
  try {
    const branch = readBranch(gitdir);
    const { changed, untracked, error } = await readStatusCounts(p, gitdir, timeoutMs);
    return {
      path: p,
      branch: branch ?? branchHint,
      changed,
      untracked,
      error,
    };
  } catch (err) {
    return {
      path: p,
      branch: branchHint,
      changed: 0,
      untracked: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function pathSnapshotEqual(a: PathSnapshot, b: PathSnapshot): boolean {
  return (
    a.path === b.path &&
    a.branch === b.branch &&
    a.changed === b.changed &&
    a.untracked === b.untracked &&
    a.error === b.error
  );
}

function snapshotEqual(a: SessionGitSnapshot, b: SessionGitSnapshot): boolean {
  if (!pathSnapshotEqual(a.project, b.project)) return false;
  if (a.worktrees.length !== b.worktrees.length) return false;
  for (let i = 0; i < a.worktrees.length; i++) {
    if (!pathSnapshotEqual(a.worktrees[i], b.worktrees[i])) return false;
  }
  return true;
}

const SESSION_REFRESH_DEBOUNCE_MS = 80;

export function createSessionGitWatcher(deps: SessionGitWatcherDeps): SessionGitWatcherService {
  const active = new Map<string, ActiveSessionWatch>();
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
  const readTimeoutMs = deps.readTimeoutMs ?? 5000;

  function emit(watchId: string, state: ActiveSessionWatch, snapshot: SessionGitSnapshot): void {
    state.last = snapshot;
    deps.sendToRenderer(`session-git-changed:${watchId}`, snapshot);
  }

  function scheduleRefresh(watchId: string, state: ActiveSessionWatch): void {
    if (state.refreshDebounceTimer) clearTimeout(state.refreshDebounceTimer);
    state.refreshDebounceTimer = setTimeout(() => {
      void runRefresh(watchId, state);
    }, SESSION_REFRESH_DEBOUNCE_MS);
  }

  /** Remove + close gitdir watchers for paths no longer tracked. */
  function pruneGitdirWatchers(state: ActiveSessionWatch, wantedPaths: Set<string>): void {
    for (const [p, w] of Array.from(state.gitdirWatchers.entries())) {
      if (!wantedPaths.has(p)) {
        try { w.close(); } catch { /* best effort */ }
        state.gitdirWatchers.delete(p);
        state.gitdirs.delete(p);
      }
    }
  }

  /** Attach gitdir watchers for any newly-tracked paths. */
  function attachGitdirWatchers(state: ActiveSessionWatch, watchId: string, paths: string[]): void {
    for (const p of paths) {
      if (state.gitdirWatchers.has(p)) continue;
      const gitdir = resolveGitdir(p);
      if (!gitdir) continue;
      state.gitdirs.set(p, gitdir);
      try {
        const w = fs.watch(gitdir, { persistent: false }, (_event, filename) => {
          if (filename && filename !== 'HEAD' && filename !== 'index') return;
          scheduleRefresh(watchId, state);
        });
        w.on('error', (err) => console.error('[session-git-watcher] gitdir watch error:', err));
        state.gitdirWatchers.set(p, w);
      } catch (err) {
        console.error('[session-git-watcher] failed to watch gitdir:', err);
      }
    }
  }

  /** Attach the worktrees/ directory watcher once the dir exists. */
  function attachWorktreesDirWatcher(state: ActiveSessionWatch, watchId: string): void {
    if (state.worktreesDirWatcher || !state.commondir) return;
    const wtDir = path.join(state.commondir, 'worktrees');
    if (!fs.existsSync(wtDir)) return;
    try {
      const w = fs.watch(wtDir, { persistent: false }, () => scheduleRefresh(watchId, state));
      w.on('error', (err) => console.error('[session-git-watcher] worktrees-dir watch error:', err));
      state.worktreesDirWatcher = w;
    } catch (err) {
      console.error('[session-git-watcher] failed to watch worktrees dir:', err);
    }
  }

  /** Re-enumerate worktrees + read all paths in parallel. Builds a fresh snapshot. */
  async function buildSnapshot(state: ActiveSessionWatch): Promise<SessionGitSnapshot> {
    // Re-list worktrees so we always reflect the current set. listWorktrees
    // never throws; on git failure it returns []. The project path is always
    // included separately so the project never disappears even if git failed.
    const peers = await listWorktrees(state.projectPath);
    const peerPaths = peers.map((p) => p.path);

    state.branchHints.clear();
    for (const p of peers) state.branchHints.set(p.path, p.branch);

    const allPaths = [state.projectPath, ...peerPaths];

    // Read each path in parallel with allSettled so a slow / failed peer
    // doesn't block the others. readPathSnapshot already never throws, so
    // allSettled is belt-and-suspenders.
    const results = await Promise.allSettled(
      allPaths.map((p) =>
        readPathSnapshot(
          p,
          state.gitdirs.get(p) ?? resolveGitdir(p),
          state.branchHints.get(p) ?? null,
          state.readTimeoutMs,
        ),
      ),
    );

    const byPath = new Map<string, PathSnapshot>();
    for (let i = 0; i < allPaths.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        byPath.set(allPaths[i], r.value);
      } else {
        // readPathSnapshot has a try/catch that should make this unreachable.
        byPath.set(allPaths[i], {
          path: allPaths[i],
          branch: state.branchHints.get(allPaths[i]) ?? null,
          changed: 0,
          untracked: 0,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }

    return {
      project: byPath.get(state.projectPath)!,
      worktrees: peerPaths
        .map((p) => byPath.get(p)!)
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
  }

  /** Refresh cycle: re-list peers, reconcile watchers, read all, emit if changed. */
  async function runRefresh(watchId: string, state: ActiveSessionWatch): Promise<SessionGitSnapshot> {
    if (state.refreshing) {
      // Another refresh is in flight — coalesce by setting refreshAgain so it
      // re-runs once after the current one completes. The caller still gets
      // the in-flight snapshot back when this is called from reconnect, but
      // that's fine — reconnect just wants something fresh-ish.
      state.refreshAgain = true;
      return state.last;
    }
    state.refreshing = true;
    try {
      const snapshot = await buildSnapshot(state);

      // Reconcile fs.watch handles against the snapshot's path set.
      const wantedPaths = new Set([state.projectPath, ...snapshot.worktrees.map((w) => w.path)]);
      pruneGitdirWatchers(state, wantedPaths);
      attachGitdirWatchers(state, watchId, Array.from(wantedPaths));
      // The first `git worktree add` creates `commondir/worktrees/`; pick it
      // up here so subsequent peers fire HEAD/index watches.
      attachWorktreesDirWatcher(state, watchId);

      if (!snapshotEqual(state.last, snapshot)) emit(watchId, state, snapshot);
      return snapshot;
    } finally {
      state.refreshing = false;
      if (state.refreshAgain) {
        state.refreshAgain = false;
        // Schedule a follow-up cycle; don't await so we don't deepen the stack.
        scheduleRefresh(watchId, state);
      }
    }
  }

  return {
    async start(projectPath) {
      const watchId = crypto.randomUUID();

      const initialEmpty: SessionGitSnapshot = {
        project: { path: projectPath, branch: null, changed: 0, untracked: 0, error: null },
        worktrees: [],
      };

      const state: ActiveSessionWatch = {
        projectPath,
        gitdirs: new Map(),
        gitdirWatchers: new Map(),
        commondirWatcher: null,
        worktreesDirWatcher: null,
        commondir: null,
        branchHints: new Map(),
        last: initialEmpty,
        pollTimer: null,
        refreshDebounceTimer: null,
        readTimeoutMs,
        refreshing: false,
        refreshAgain: false,
      };

      // Resolve the project's commondir up-front so we can watch it for the
      // worktrees/ directory being created on the first `git worktree add`.
      const projectGitdir = resolveGitdir(projectPath);
      if (projectGitdir) {
        state.commondir = await resolveCommondir(projectPath, projectGitdir);
        try {
          const cmw = fs.watch(state.commondir, { persistent: false }, (_e, filename) => {
            // The commondir watcher is just a tripwire for `worktrees/` being
            // created/removed. The peer-list refresh covers the rest.
            if (filename === 'worktrees' || filename === null) scheduleRefresh(watchId, state);
          });
          cmw.on('error', (err) => console.error('[session-git-watcher] commondir watch error:', err));
          state.commondirWatcher = cmw;
        } catch (err) {
          console.error('[session-git-watcher] failed to watch commondir:', err);
        }
      }

      active.set(watchId, state);

      // Seed: build the initial snapshot synchronously (well, in a single
      // await) so the renderer renders with real data on its first paint.
      const snapshot = await runRefresh(watchId, state);

      // Working-tree edits don't touch any .git/ — poll periodically.
      state.pollTimer = setInterval(() => {
        scheduleRefresh(watchId, state);
      }, pollIntervalMs);
      if (typeof state.pollTimer.unref === 'function') state.pollTimer.unref();

      return { watchId, snapshot };
    },

    async reconnect(watchId) {
      const state = active.get(watchId);
      if (!state) return null;

      // Tear down stale gitdir + worktrees-dir watchers; runRefresh will
      // recreate them based on the freshly-listed peer set.
      for (const [p, w] of Array.from(state.gitdirWatchers.entries())) {
        try { w.close(); } catch { /* best effort */ }
        state.gitdirWatchers.delete(p);
        state.gitdirs.delete(p);
      }
      if (state.worktreesDirWatcher) {
        try { state.worktreesDirWatcher.close(); } catch { /* best effort */ }
        state.worktreesDirWatcher = null;
      }

      return runRefresh(watchId, state);
    },

    stop(watchId) {
      const state = active.get(watchId);
      if (!state) return;
      if (state.refreshDebounceTimer) clearTimeout(state.refreshDebounceTimer);
      if (state.pollTimer) clearInterval(state.pollTimer);
      for (const w of state.gitdirWatchers.values()) {
        try { w.close(); } catch { /* best effort */ }
      }
      if (state.commondirWatcher) {
        try { state.commondirWatcher.close(); } catch { /* best effort */ }
      }
      if (state.worktreesDirWatcher) {
        try { state.worktreesDirWatcher.close(); } catch { /* best effort */ }
      }
      active.delete(watchId);
    },

    disposeAll() {
      for (const id of Array.from(active.keys())) this.stop(id);
    },
  };
}
