import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

import { gitBinary } from './git-binary';

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
  return runWorktreeList(projectPath, selfReal);
}

/** `git worktree list`, parsed, minus `excludeReal` (pass '' to keep every entry). */
function runWorktreeList(cwd: string, excludeReal: string): Promise<WorktreeInfo[]> {
  return new Promise((resolve) => {
    execFile(
      gitBinary(),
      ['worktree', 'list', '--porcelain'],
      { cwd, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        resolve(parseWorktreePorcelain(stdout, excludeReal));
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
      gitBinary(),
      // --no-optional-locks: a plain `git status` refreshes .git/index, and
      // the index watcher below would see that write and schedule another
      // refresh — every poll triggering a second one. Background readers
      // (VS Code's included) run it this way for exactly that reason.
      ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--ignore-submodules=dirty'],
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
            // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- preserved for readability; auto-fix would obscure null-guard intent.
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
      gitBinary(),
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
// SessionGitWatcher — the branch/changes badges for every session tab.
//
// Each `start()` returns a watch id, and every snapshot for it arrives on
// `session-git-changed:<watchId>` as {project, worktrees[]}. Behind the ids,
// ONE reader per repository (keyed by the realpath of its commondir, so every
// worktree of a repo and every symlinked path to it share it) runs git once
// per path per refresh and fans the result out to every watch on it.
//
// Every `git` is a short-lived process, and on macOS each one costs syspolicyd
// two log errors — measured at ~3.4M a day from an idle app polling 20 paths
// every 3 s. So:
//   - watches share a reader (above), reference-counted by stop();
//   - the reader polls only while at least one of its watches is visible
//     (`setVisible`, driven by the renderer: active tab, visible document,
//     screen unlocked). Hidden, nothing runs; what changed meanwhile is
//     remembered and read once, the moment a watch becomes visible again;
//   - a watch started over the remote protocol is held by that client's
//     connection; when the connection closes, the watch goes hidden. A window
//     closed on a daemon-only machine otherwise left every watch it had
//     "visible" and polling forever. The next call from a (re)connected
//     client re-claims it;
//   - `git` runs by absolute path (see git-binary.ts);
//   - a poll tick reads status only. `git worktree list` runs when the reader
//     is created, on reconnect, and when the commondir / `worktrees/`
//     watchers say the set of worktrees changed.
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

/**
 * The client connection a call arrived on. The last one to call about a watch
 * holds it; when that connection closes, the watch goes hidden. Absent on the
 * in-process IPC path, whose renderer dies with the app.
 */
export interface WatchHolder {
  onClose(listener: () => void): void;
}

export interface SessionGitWatcherService {
  start(projectPath: string, holder?: WatchHolder): Promise<{ watchId: string; snapshot: SessionGitSnapshot }>;
  reconnect(watchId: string, holder?: WatchHolder): Promise<SessionGitSnapshot | null>;
  stop(watchId: string): void;
  /**
   * Whether anyone is looking at this watch. A new watch starts visible, so a
   * client that never calls this keeps today's behaviour.
   */
  setVisible(watchId: string, visible: boolean, holder?: WatchHolder): void;
  disposeAll(): void;
}

export interface SessionGitWatcherDeps extends GitWatcherDeps {
  /** Per-`git status` timeout in ms. Defaults to 5000. */
  readTimeoutMs?: number;
}

/** A status read covers known paths; a full one re-lists worktrees first. */
type RefreshKind = 'status' | 'full';

const mergeKind = (a: RefreshKind | null, b: RefreshKind | null): RefreshKind | null =>
  a === 'full' || b === 'full' ? 'full' : a ?? b;

interface Subscriber {
  watchId: string;
  /** As the caller gave it — echoed back as `project.path`. */
  projectPath: string;
  projectReal: string;
  visible: boolean;
  holder: WatchHolder | null;
  /** Last snapshot sent to this watch, to skip no-op emits. */
  last: SessionGitSnapshot;
}

interface RepoReader {
  key: string;
  /** Where `git worktree list` runs; any path in the repository will do. */
  anchor: string;
  commondir: string | null;
  /** Real paths of every worktree from the last `git worktree list`. */
  worktreePaths: string[];
  branchHints: Map<string, string | null>;
  /** Latest reading per real path. */
  readings: Map<string, PathSnapshot>;
  gitdirs: Map<string, string>;
  gitdirWatchers: Map<string, fs.FSWatcher>;
  commondirWatcher: fs.FSWatcher | null;
  worktreesDirWatcher: fs.FSWatcher | null;
  subscribers: Map<string, Subscriber>;
  pollTimer: NodeJS.Timeout | null;
  debounceTimer: NodeJS.Timeout | null;
  /** Work deferred while nobody was looking, or while a refresh was running. */
  pending: RefreshKind | null;
  refreshing: boolean;
  /** Settles when the reader's first full read has landed. */
  seeded: Promise<void>;
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
    return { path: p, branch: branch ?? branchHint, changed, untracked, error };
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

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

const emptyReading = (p: string): PathSnapshot => ({ path: p, branch: null, changed: 0, untracked: 0, error: null });

const SESSION_REFRESH_DEBOUNCE_MS = 80;

export function createSessionGitWatcher(deps: SessionGitWatcherDeps): SessionGitWatcherService {
  const readers = new Map<string, RepoReader>();
  const readerByWatch = new Map<string, RepoReader>();
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
  const readTimeoutMs = deps.readTimeoutMs ?? 5000;

  const anyVisible = (r: RepoReader): boolean => {
    for (const s of r.subscribers.values()) if (s.visible) return true;
    return false;
  };

  function snapshotFor(r: RepoReader, sub: Subscriber): SessionGitSnapshot {
    const own = r.readings.get(sub.projectReal) ?? emptyReading(sub.projectReal);
    return {
      project: { ...own, path: sub.projectPath },
      worktrees: r.worktreePaths
        .filter((p) => p !== sub.projectReal)
        .map((p) => r.readings.get(p) ?? { ...emptyReading(p), branch: r.branchHints.get(p) ?? null })
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
  }

  function emitAll(r: RepoReader): void {
    for (const sub of r.subscribers.values()) {
      const snap = snapshotFor(r, sub);
      if (snapshotEqual(sub.last, snap)) continue;
      sub.last = snap;
      deps.sendToRenderer(`session-git-changed:${sub.watchId}`, snap);
    }
  }

  /** Ask for a refresh. Nobody looking: remember it for when someone is. */
  function schedule(r: RepoReader, kind: RefreshKind): void {
    if (!anyVisible(r)) {
      r.pending = mergeKind(r.pending, kind);
      return;
    }
    r.pending = mergeKind(r.pending, kind);
    if (r.debounceTimer) clearTimeout(r.debounceTimer);
    r.debounceTimer = setTimeout(() => {
      r.debounceTimer = null;
      const k = r.pending ?? 'status';
      r.pending = null;
      void refresh(r, k);
    }, SESSION_REFRESH_DEBOUNCE_MS);
  }

  function reconcileWatchers(r: RepoReader, paths: string[]): void {
    const wanted = new Set(paths);
    for (const [p, w] of Array.from(r.gitdirWatchers.entries())) {
      if (wanted.has(p)) continue;
      try { w.close(); } catch { /* best effort */ }
      r.gitdirWatchers.delete(p);
      r.gitdirs.delete(p);
    }
    for (const p of paths) {
      if (r.gitdirWatchers.has(p)) continue;
      const gitdir = resolveGitdir(p);
      if (!gitdir) continue;
      r.gitdirs.set(p, gitdir);
      try {
        const w = fs.watch(gitdir, { persistent: false }, (_event, filename) => {
          if (filename && filename !== 'HEAD' && filename !== 'index') return;
          schedule(r, 'status');
        });
        w.on('error', (err) => console.error('[session-git-watcher] gitdir watch error:', err));
        r.gitdirWatchers.set(p, w);
      } catch (err) {
        console.error('[session-git-watcher] failed to watch gitdir:', err);
      }
    }
    // The first `git worktree add` creates `commondir/worktrees/`; pick it up
    // here so later adds and removes are seen without a poll.
    if (!r.worktreesDirWatcher && r.commondir) {
      const wtDir = path.join(r.commondir, 'worktrees');
      if (fs.existsSync(wtDir)) {
        try {
          const w = fs.watch(wtDir, { persistent: false }, () => { schedule(r, 'full'); });
          w.on('error', (err) => console.error('[session-git-watcher] worktrees-dir watch error:', err));
          r.worktreesDirWatcher = w;
        } catch (err) {
          console.error('[session-git-watcher] failed to watch worktrees dir:', err);
        }
      }
    }
  }

  /** Read every path once (after re-listing worktrees, for a full refresh) and fan out. */
  async function refresh(r: RepoReader, kind: RefreshKind): Promise<void> {
    if (r.refreshing) {
      r.pending = mergeKind(r.pending, kind);
      return;
    }
    r.refreshing = true;
    try {
      if (kind === 'full' && r.commondir) {
        const listed = await runWorktreeList(r.anchor, '');
        r.worktreePaths = listed.map((w) => w.path);
        r.branchHints = new Map(listed.map((w) => [w.path, w.branch]));
      }
      const paths = Array.from(new Set([
        ...r.worktreePaths,
        ...Array.from(r.subscribers.values(), (s) => s.projectReal),
      ]));
      const results = await Promise.all(paths.map((p) =>
        readPathSnapshot(p, r.gitdirs.get(p) ?? resolveGitdir(p), r.branchHints.get(p) ?? null, readTimeoutMs),
      ));
      r.readings = new Map(paths.map((p, i) => [p, results[i]]));
      reconcileWatchers(r, paths);
      emitAll(r);
    } finally {
      r.refreshing = false;
      // Anything asked for mid-read runs next — through schedule(), so it
      // waits again if everyone has looked away in the meantime.
      if (r.pending && readers.get(r.key) === r) {
        const next = r.pending;
        r.pending = null;
        schedule(r, next);
      }
    }
  }

  /** Poll while someone is looking; stop the moment nobody is. */
  function syncPolling(r: RepoReader): void {
    const want = anyVisible(r);
    if (want && !r.pollTimer) {
      r.pollTimer = setInterval(() => { schedule(r, 'status'); }, pollIntervalMs);
      if (typeof r.pollTimer.unref === 'function') r.pollTimer.unref();
    } else if (!want && r.pollTimer) {
      clearInterval(r.pollTimer);
      r.pollTimer = null;
    }
  }

  /** Make `holder` the connection this watch lives and dies with. */
  function claim(sub: Subscriber, holder: WatchHolder | undefined): void {
    if (!holder || sub.holder === holder) return;
    sub.holder = holder;
    holder.onClose(() => {
      if (sub.holder !== holder) return;
      sub.holder = null;
      const r = readerByWatch.get(sub.watchId);
      if (!r || !sub.visible) return;
      sub.visible = false;
      syncPolling(r);
    });
  }

  function dispose(r: RepoReader): void {
    if (r.debounceTimer) clearTimeout(r.debounceTimer);
    if (r.pollTimer) clearInterval(r.pollTimer);
    for (const w of r.gitdirWatchers.values()) {
      try { w.close(); } catch { /* best effort */ }
    }
    for (const w of [r.commondirWatcher, r.worktreesDirWatcher]) {
      if (!w) continue;
      try { w.close(); } catch { /* best effort */ }
    }
    readers.delete(r.key);
  }

  async function readerFor(projectReal: string): Promise<{ r: RepoReader; created: boolean }> {
    const gitdir = resolveGitdir(projectReal);
    const commondir = gitdir ? realpathOr(await resolveCommondir(projectReal, gitdir)) : null;
    const key = commondir ? `git:${commondir}` : `path:${projectReal}`;
    const existing = readers.get(key);
    if (existing) return { r: existing, created: false };

    const r: RepoReader = {
      key,
      anchor: projectReal,
      commondir,
      worktreePaths: [],
      branchHints: new Map(),
      readings: new Map(),
      gitdirs: new Map(),
      gitdirWatchers: new Map(),
      commondirWatcher: null,
      worktreesDirWatcher: null,
      subscribers: new Map(),
      pollTimer: null,
      debounceTimer: null,
      pending: null,
      refreshing: false,
      seeded: Promise.resolve(),
    };
    readers.set(key, r);
    if (commondir) {
      try {
        const w = fs.watch(commondir, { persistent: false }, (_e, filename) => {
          // A tripwire for `worktrees/` appearing or going; the full refresh
          // it schedules re-lists everything else.
          if (filename === 'worktrees' || filename === null) schedule(r, 'full');
        });
        w.on('error', (err) => console.error('[session-git-watcher] commondir watch error:', err));
        r.commondirWatcher = w;
      } catch (err) {
        console.error('[session-git-watcher] failed to watch commondir:', err);
      }
    }
    // Seeded as a full read, whatever the visibility: the first paint needs data.
    r.seeded = refresh(r, 'full');
    return { r, created: true };
  }

  return {
    async start(projectPath, holder) {
      const watchId = crypto.randomUUID();
      const projectReal = realpathOr(projectPath);
      const { r, created } = await readerFor(projectReal);
      const wasVisible = anyVisible(r);
      const sub: Subscriber = {
        watchId,
        projectPath,
        projectReal,
        visible: true,
        holder: null,
        last: { project: emptyReading(projectPath), worktrees: [] },
      };
      claim(sub, holder);
      r.subscribers.set(watchId, sub);
      readerByWatch.set(watchId, r);
      await r.seeded;
      // Read now if this path was never read (a worktree not yet re-listed),
      // or if the reader sat unwatched — its readings are as old as the last
      // time anyone looked, and working-tree edits never woke it. A reader
      // created just now was seeded a moment ago; joining a watched one costs
      // nothing.
      if (!r.readings.has(projectReal) || (!created && !wasVisible)) {
        const kind = mergeKind(r.pending, 'status') ?? 'status';
        r.pending = null;
        await refresh(r, kind);
      }
      syncPolling(r);
      sub.last = snapshotFor(r, sub);
      return { watchId, snapshot: sub.last };
    },

    async reconnect(watchId, holder) {
      const r = readerByWatch.get(watchId);
      const sub = r?.subscribers.get(watchId);
      if (!r || !sub) return null;
      claim(sub, holder);
      await r.seeded;
      // Tear down the per-path and worktrees/ watchers; the full refresh
      // re-creates them from a freshly listed set.
      for (const w of r.gitdirWatchers.values()) {
        try { w.close(); } catch { /* best effort */ }
      }
      r.gitdirWatchers.clear();
      r.gitdirs.clear();
      if (r.worktreesDirWatcher) {
        try { r.worktreesDirWatcher.close(); } catch { /* best effort */ }
        r.worktreesDirWatcher = null;
      }
      await refresh(r, 'full');
      return snapshotFor(r, sub);
    },

    setVisible(watchId, visible, holder) {
      const r = readerByWatch.get(watchId);
      const sub = r?.subscribers.get(watchId);
      if (!r || !sub) return;
      claim(sub, holder);
      if (sub.visible === visible) return;
      const wasVisible = anyVisible(r);
      sub.visible = visible;
      syncPolling(r);
      if (!wasVisible && visible) {
        // Back in view: one read now, covering whatever was deferred.
        const kind = mergeKind(r.pending, 'status') ?? 'status';
        r.pending = null;
        void refresh(r, kind);
      }
    },

    stop(watchId) {
      const r = readerByWatch.get(watchId);
      readerByWatch.delete(watchId);
      if (!r) return;
      r.subscribers.delete(watchId);
      if (r.subscribers.size === 0) dispose(r);
      else syncPolling(r);
    },

    disposeAll() {
      for (const r of Array.from(readers.values())) dispose(r);
      readerByWatch.clear();
    },
  };
}
