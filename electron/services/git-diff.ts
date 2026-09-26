import { execFile } from 'node:child_process';
import * as path from 'node:path';

import { gitBinary } from './git-binary';

/**
 * Working-tree file list and per-file patches for the git diff side panel.
 *
 * This is deliberately separate from `git-watcher.ts`. The watcher polls every
 * 3s and pushes its snapshot to every open tab over `session-git-changed:`,
 * so it counts files and throws the paths away on purpose — a path list in
 * that payload would be pushed to every renderer several times a minute for
 * every worktree. These reads are pull-only: they run when the user opens the
 * panel or picks a file, and never on a timer.
 *
 * Patches are produced against HEAD rather than the index. `git diff` alone
 * shows only unstaged changes, so a working tree whose edits are all staged
 * renders as an empty patch — which reads as "no changes" and is the single
 * most confusing thing this panel could do.
 */

/** Max bytes of patch text to accept from git before giving up. */
const DIFF_MAX_BUFFER = 16 * 1024 * 1024;

/** Default timeout for a single git invocation, ms. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** git's own default context width, and ours. */
const DEFAULT_CONTEXT_LINES = 3;

export interface ReadFileDiffOptions {
  /**
   * Unchanged lines to keep either side of each hunk. The split view's expand
   * affordance walks this upward — a very large value yields the whole file,
   * which is how "expand all" is expressed without a second code path.
   */
  contextLines?: number;
  timeoutMs?: number;
}

export type ChangedFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked';

export interface ChangedFile {
  /** Repo-relative path, forward slashes, as git reports it. */
  path: string;
  status: ChangedFileStatus;
  /** True when the index differs from HEAD for this path. */
  staged: boolean;
  /** Previous path, present only on renames. */
  origPath?: string;
}

interface RunResult {
  stdout: string;
  /** Non-null when git exited non-zero or could not be run at all. */
  error: string | null;
}

function run(args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      gitBinary(),
      args,
      { cwd, maxBuffer: DIFF_MAX_BUFFER, windowsHide: true, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) {
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
          const msg = killed
            ? `git timed out after ${timeoutMs}ms`
            : (stderr && stderr.toString().trim()) || err.message || 'git failed';
          resolve({ stdout: stdout ? stdout.toString() : '', error: msg });
          return;
        }
        resolve({ stdout: stdout.toString(), error: null });
      },
    );
  });
}

function statusFor(xy: string): ChangedFileStatus {
  if (xy === '??') return 'untracked';
  // A delete on either side wins: the file is gone from the working tree, and
  // that is what the reader needs to know before opening a patch for it.
  if (xy.includes('D')) return 'deleted';
  if (xy.startsWith('R')) return 'renamed';
  if (xy.startsWith('A')) return 'added';
  return 'modified';
}

/**
 * Parse `git status --porcelain=v1 -z` into one entry per path.
 *
 * Each entry is `XY <path>\0`. Rename and copy entries carry a SECOND
 * NUL-delimited field holding the original path; consuming only one field
 * leaves the next read starting at that original path, which silently
 * mis-attributes the status of every file after a rename.
 */
function parsePorcelainV1Z(buf: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  const tokens = buf.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!tok || tok.length < 4) { i++; continue; }
    const xy = tok.slice(0, 2);
    const filePath = tok.slice(3);
    // `!!` is an ignored entry; we never ask for those, but tolerate them.
    if (xy === '!!') { i += 1; continue; }

    const isRenameOrCopy = xy.startsWith('R') || xy.startsWith('C');
    const origPath = isRenameOrCopy ? tokens[i + 1] : undefined;

    const entry: ChangedFile = {
      path: filePath,
      status: statusFor(xy),
      staged: xy !== '??' && xy[0] !== ' ',
    };
    if (origPath) entry.origPath = origPath;
    out.push(entry);

    i += isRenameOrCopy ? 2 : 1;
  }
  return out;
}

/**
 * List every changed path in the working tree at `projectPath`.
 * Returns [] when the directory is not a repo or git cannot be run — this
 * backs a panel, and a missing repo is a normal state, not an error.
 */
export async function listChangedFiles(
  projectPath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ChangedFile[]> {
  const { stdout, error } = await run(
    ['status', '--porcelain=v1', '-z', '--ignore-submodules=dirty'],
    projectPath,
    timeoutMs,
  );
  if (error) return [];
  return parsePorcelainV1Z(stdout);
}

/**
 * Resolve a renderer-supplied repo-relative path against the project root,
 * refusing anything that escapes it.
 *
 * `filePath` crosses IPC from the renderer. Without this, `../../etc/passwd`
 * would be handed straight to `git diff` and read outside the project the
 * user actually opened.
 */
function resolveInside(projectPath: string, filePath: string): string {
  const root = path.resolve(projectPath);
  const resolved = path.resolve(root, filePath);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to diff a path outside the project: ${filePath}`);
  }
  return rel;
}

async function isUntracked(
  projectPath: string,
  relPath: string,
  timeoutMs: number,
): Promise<boolean> {
  const { stdout, error } = await run(
    ['ls-files', '--others', '--exclude-standard', '-z', '--', relPath],
    projectPath,
    timeoutMs,
  );
  if (error) return false;
  return stdout.split('\0').some((p) => p === relPath);
}

/**
 * Read a unified patch for one file.
 *
 * Returns '' when the file has no changes, when the directory is not a repo,
 * or when git cannot be run. Throws only for a path that escapes the project.
 */
export async function readFileDiff(
  projectPath: string,
  filePath: string,
  opts: ReadFileDiffOptions = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const context = Math.max(0, Math.trunc(opts.contextLines ?? DEFAULT_CONTEXT_LINES));
  const relPath = resolveInside(projectPath, filePath);

  // Tracked changes, staged and unstaged together.
  const tracked = await run(
    ['diff', 'HEAD', `-U${context}`, '--', relPath],
    projectPath,
    timeoutMs,
  );
  if (tracked.stdout.length > 0) return tracked.stdout;

  // An untracked file is in no tree, so `git diff HEAD` has nothing to say
  // about it. `--no-index` against /dev/null renders it as all-additions —
  // and exits 1 when the two differ, which is success here, not failure.
  if (await isUntracked(projectPath, relPath, timeoutMs)) {
    const untracked = await run(
      ['diff', '--no-index', `-U${context}`, '--', '/dev/null', relPath],
      projectPath,
      timeoutMs,
    );
    return untracked.stdout;
  }

  return '';
}
