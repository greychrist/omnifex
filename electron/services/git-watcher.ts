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
// `session-git-changed:<watchId>` as {repos[], foundCount}: one entry per repo
// the project watches (its own folder, when a repo, plus the sub-repos the
// user turned on — `SessionGitRepoSource`), each with its worktrees. A watch
// subscribes to the reader of every repo it shows, and `reconfigure()`
// re-subscribes a project's live watches when its choices change. Behind the
// ids, ONE reader per repository (keyed by the realpath of its commondir, so every
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

export interface RepoSnapshot {
  /** Relative to the project folder; '' for the project folder itself. */
  name: string;
  /** The repo's own checkout. */
  root: PathSnapshot;
  /** Sibling worktrees, sorted by path. */
  worktrees: PathSnapshot[];
}

export interface SessionGitSnapshot {
  /** The project folder's repo first (when it is one), then watched sub-repos. */
  repos: RepoSnapshot[];
  /** Repos discovered in the project and not watched. */
  foundCount: number;
}

/** Which repos a project's sessions watch — `ProjectReposService` in the daemon. */
export interface SessionGitRepoSource {
  watchedRepos(projectPath: string): { path: string; name: string }[];
  foundCount(projectPath: string): Promise<number>;
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
  /** Re-read which repos `projectPath` watches and re-subscribe its live watches. */
  reconfigure(projectPath: string): Promise<void>;
  disposeAll(): void;
}

export interface SessionGitWatcherDeps extends GitWatcherDeps {
  /** Per-`git status` timeout in ms. Defaults to 5000. */
  readTimeoutMs?: number;
  /** Defaults to: the project folder alone, when it is a repo; nothing found. */
  repos?: SessionGitRepoSource;
}

/** A status read covers known paths; a full one re-lists worktrees first. */
type RefreshKind = 'status' | 'full';

const mergeKind = (a: RefreshKind | null, b: RefreshKind | null): RefreshKind | null =>
  a === 'full' || b === 'full' ? 'full' : a ?? b;

/** One session's watch: a subscriber on the reader of each repo it shows. */
interface Watch {
  id: string;
  projectPath: string;
  projectReal: string;
  visible: boolean;
  holder: WatchHolder | null;
  /** Real repo paths, in display order. */
  order: string[];
  subs: Map<string, Subscriber>;
  foundCount: number;
  /** Last snapshot sent to this watch, to skip no-op emits. */
  last: SessionGitSnapshot;
  /** Syncs run one at a time: a quick on/off must not interleave. */
  syncing: Promise<void>;
}

/** A watch's interest in one repo, registered on that repo's reader. */
interface Subscriber {
  id: string;
  watch: Watch;
  reader: RepoReader;
  name: string;
  /** Echoed back as `root.path`: the caller's project path for the project's own repo. */
  repoPath: string;
  repoReal: string;
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
  // A watched repo deleted on disk: say so, rather than spawning git into a
  // missing cwd and reporting that as "spawn git ENOENT".
  if (!fs.existsSync(p)) {
    return { path: p, branch: branchHint, changed: 0, untracked: 0, error: 'Folder no longer exists' };
  }
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

function pathListEqual(a: PathSnapshot[], b: PathSnapshot[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!pathSnapshotEqual(a[i], b[i])) return false;
  }
  return true;
}

function snapshotEqual(a: SessionGitSnapshot, b: SessionGitSnapshot): boolean {
  if (a.foundCount !== b.foundCount || a.repos.length !== b.repos.length) return false;
  for (let i = 0; i < a.repos.length; i++) {
    const x = a.repos[i];
    const y = b.repos[i];
    if (x.name !== y.name || !pathSnapshotEqual(x.root, y.root) || !pathListEqual(x.worktrees, y.worktrees)) return false;
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
  const watches = new Map<string, Watch>();
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
  const readTimeoutMs = deps.readTimeoutMs ?? 5000;
  const repoSource: SessionGitRepoSource = deps.repos ?? {
    watchedRepos: (p) => {
      const real = realpathOr(p);
      return resolveGitdir(real) ? [{ path: real, name: '' }] : [];
    },
    foundCount: async () => 0,
  };

  const anyVisible = (r: RepoReader): boolean => {
    for (const s of r.subscribers.values()) if (s.watch.visible) return true;
    return false;
  };

  function repoSnapshot(sub: Subscriber): RepoSnapshot {
    const r = sub.reader;
    const own = r.readings.get(sub.repoReal) ?? emptyReading(sub.repoReal);
    return {
      name: sub.name,
      root: { ...own, path: sub.repoPath },
      worktrees: r.worktreePaths
        .filter((p) => p !== sub.repoReal)
        .map((p) => r.readings.get(p) ?? { ...emptyReading(p), branch: r.branchHints.get(p) ?? null })
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
  }

  function snapshotFor(w: Watch): SessionGitSnapshot {
    const repos: RepoSnapshot[] = [];
    for (const real of w.order) {
      const sub = w.subs.get(real);
      if (sub) repos.push(repoSnapshot(sub));
    }
    return { repos, foundCount: w.foundCount };
  }

  function emitWatch(w: Watch): void {
    if (watches.get(w.id) !== w) return;
    const snap = snapshotFor(w);
    if (snapshotEqual(w.last, snap)) return;
    w.last = snap;
    deps.sendToRenderer(`session-git-changed:${w.id}`, snap);
  }

  function emitAll(r: RepoReader): void {
    const seen = new Set<Watch>();
    for (const sub of r.subscribers.values()) {
      if (seen.has(sub.watch)) continue;
      seen.add(sub.watch);
      emitWatch(sub.watch);
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
        ...Array.from(r.subscribers.values(), (s) => s.repoReal),
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
  function claim(w: Watch, holder: WatchHolder | undefined): void {
    if (!holder || w.holder === holder) return;
    w.holder = holder;
    holder.onClose(() => {
      if (w.holder !== holder) return;
      w.holder = null;
      if (!w.visible || watches.get(w.id) !== w) return;
      w.visible = false;
      for (const r of readersOf(w)) syncPolling(r);
    });
  }

  function readersOf(w: Watch): RepoReader[] {
    return Array.from(new Set(Array.from(w.subs.values(), (s) => s.reader)));
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

  async function readerFor(repoReal: string): Promise<{ r: RepoReader; created: boolean }> {
    const gitdir = resolveGitdir(repoReal);
    const commondir = gitdir ? realpathOr(await resolveCommondir(repoReal, gitdir)) : null;
    const key = commondir ? `git:${commondir}` : `path:${repoReal}`;
    const existing = readers.get(key);
    if (existing) return { r: existing, created: false };

    const r: RepoReader = {
      key,
      anchor: repoReal,
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

  /** Subscribe `w` to the reader of one repo, reading it now if its readings are stale. */
  async function attach(w: Watch, repo: { path: string; name: string }): Promise<void> {
    const repoReal = realpathOr(repo.path);
    const { r, created } = await readerFor(repoReal);
    // The watch may have stopped, or dropped this repo, while the reader was
    // being found. Registering now would leave it polling with no way to stop.
    if (watches.get(w.id) !== w || !w.order.includes(repoReal) || w.subs.has(repoReal)) {
      if (r.subscribers.size === 0) dispose(r);
      return;
    }
    const wasVisible = anyVisible(r);
    const sub: Subscriber = {
      id: `${w.id}\0${repoReal}`,
      watch: w,
      reader: r,
      name: repo.name,
      // The project's own repo echoes the caller's path, as it always has.
      repoPath: repo.name === '' ? w.projectPath : repoReal,
      repoReal,
    };
    r.subscribers.set(sub.id, sub);
    w.subs.set(repoReal, sub);
    await r.seeded;
    // Read now if this path was never read (a worktree not yet re-listed),
    // or if the reader sat unwatched — its readings are as old as the last
    // time anyone looked, and working-tree edits never woke it. A reader
    // created just now was seeded a moment ago; joining a watched one costs
    // nothing.
    if (!r.readings.has(repoReal) || (!created && !wasVisible)) {
      const kind = mergeKind(r.pending, 'status') ?? 'status';
      r.pending = null;
      await refresh(r, kind);
    }
    syncPolling(r);
  }

  function detach(sub: Subscriber): void {
    const r = sub.reader;
    r.subscribers.delete(sub.id);
    sub.watch.subs.delete(sub.repoReal);
    if (r.subscribers.size === 0) dispose(r);
    else syncPolling(r);
  }

  /** Bring `w`'s subscriptions in line with what its project watches now, one sync at a time. */
  function sync(w: Watch): Promise<void> {
    w.syncing = w.syncing.then(() => syncNow(w), () => syncNow(w));
    return w.syncing;
  }

  async function syncNow(w: Watch): Promise<void> {
    if (watches.get(w.id) !== w) return;
    const wanted = repoSource.watchedRepos(w.projectPath)
      .map((repo) => ({ ...repo, real: realpathOr(repo.path) }));
    const wantedReal = new Set(wanted.map((x) => x.real));
    for (const sub of Array.from(w.subs.values())) {
      if (!wantedReal.has(sub.repoReal)) detach(sub);
    }
    w.order = wanted.map((x) => x.real);
    const [, found] = await Promise.all([
      Promise.all(wanted.filter((x) => !w.subs.has(x.real)).map((x) => attach(w, x))),
      repoSource.foundCount(w.projectPath).catch(() => 0),
    ]);
    w.foundCount = found;
  }

  return {
    async start(projectPath, holder) {
      const w: Watch = {
        id: crypto.randomUUID(),
        projectPath,
        projectReal: realpathOr(projectPath),
        visible: true,
        holder: null,
        order: [],
        subs: new Map(),
        foundCount: 0,
        last: { repos: [], foundCount: 0 },
        syncing: Promise.resolve(),
      };
      claim(w, holder);
      watches.set(w.id, w);
      await sync(w);
      w.last = snapshotFor(w);
      return { watchId: w.id, snapshot: w.last };
    },

    async reconnect(watchId, holder) {
      const w = watches.get(watchId);
      if (!w) return null;
      claim(w, holder);
      await Promise.all(readersOf(w).map(async (r) => {
        await r.seeded;
        // Tear down the per-path and worktrees/ watchers; the full refresh
        // re-creates them from a freshly listed set.
        for (const fw of r.gitdirWatchers.values()) {
          try { fw.close(); } catch { /* best effort */ }
        }
        r.gitdirWatchers.clear();
        r.gitdirs.clear();
        if (r.worktreesDirWatcher) {
          try { r.worktreesDirWatcher.close(); } catch { /* best effort */ }
          r.worktreesDirWatcher = null;
        }
        await refresh(r, 'full');
      }));
      return snapshotFor(w);
    },

    setVisible(watchId, visible, holder) {
      const w = watches.get(watchId);
      if (!w) return;
      claim(w, holder);
      if (w.visible === visible) return;
      const rs = readersOf(w);
      const was = new Map(rs.map((r) => [r, anyVisible(r)]));
      w.visible = visible;
      for (const r of rs) {
        syncPolling(r);
        if (!was.get(r) && visible) {
          // Back in view: one read now, covering whatever was deferred.
          const kind = mergeKind(r.pending, 'status') ?? 'status';
          r.pending = null;
          void refresh(r, kind);
        }
      }
    },

    async reconfigure(projectPath) {
      const real = realpathOr(projectPath);
      await Promise.all(Array.from(watches.values())
        .filter((w) => w.projectReal === real)
        .map(async (w) => {
          await sync(w);
          emitWatch(w);
        }));
    },

    stop(watchId) {
      const w = watches.get(watchId);
      if (!w) return;
      watches.delete(watchId);
      for (const sub of Array.from(w.subs.values())) detach(sub);
    },

    disposeAll() {
      for (const r of Array.from(readers.values())) dispose(r);
      watches.clear();
    },
  };
}
