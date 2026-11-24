import { execFile } from 'node:child_process';
import * as path from 'node:path';

import { gitBinary } from './git-binary';

// Pull-only, never on a timer: the watcher's pushed snapshot must not carry path lists.
// Patches are against HEAD: plain `git diff` shows only unstaged changes, so all-staged edits look like none.

const DIFF_MAX_BUFFER = 16 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 10_000;

const DEFAULT_CONTEXT_LINES = 3;

export interface ReadFileDiffOptions {
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
  path: string;
  status: ChangedFileStatus;
  staged: boolean;
  origPath?: string;
}

interface RunResult {
  stdout: string;
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
            : stderr?.toString().trim() || err.message || 'git failed';
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
  if (xy.includes('D')) return 'deleted';
  if (xy.startsWith('R')) return 'renamed';
  if (xy.startsWith('A')) return 'added';
  return 'modified';
}

/** Rename/copy entries carry a second NUL field; skipping it mis-attributes every later file. */
function parsePorcelainV1Z(buf: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  const tokens = buf.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!tok || tok.length < 4) { i++; continue; }
    const xy = tok.slice(0, 2);
    const filePath = tok.slice(3);
    if (xy === '!!') { i += 1; continue; }

    const isRenameOrCopy = xy.startsWith('R') || xy.startsWith('C');
    const origPath = isRenameOrCopy ? tokens[i + 1] : undefined;

    const entry: ChangedFile = {
      path: filePath,
      status: statusFor(xy),
      staged: xy !== '??' && !xy.startsWith(' '),
    };
    if (origPath) entry.origPath = origPath;
    out.push(entry);

    i += isRenameOrCopy ? 2 : 1;
  }
  return out;
}

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

/** `filePath` comes from the renderer: refuse anything that escapes the project. */
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

export async function readFileDiff(
  projectPath: string,
  filePath: string,
  opts: ReadFileDiffOptions = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const context = Math.max(0, Math.trunc(opts.contextLines ?? DEFAULT_CONTEXT_LINES));
  const relPath = resolveInside(projectPath, filePath);

  const tracked = await run(
    ['diff', 'HEAD', `-U${context}`, '--', relPath],
    projectPath,
    timeoutMs,
  );
  if (tracked.stdout.length > 0) return tracked.stdout;

  // `--no-index` exits 1 when the files differ, which is success here.
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
