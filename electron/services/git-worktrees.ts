import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Injectable exec for testing. Mirrors execFileSync's shape but returns a string. */
export type ExecSyncFn = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number },
) => string;

const defaultExec: ExecSyncFn = (cmd, args, opts) =>
  execFileSync(cmd, args, { ...opts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** Parse `git worktree list --porcelain` output. Each block starts with a
 *  `worktree <path>` line; the rest (HEAD, branch, detached, bare, locked,
 *  prunable) is informational and ignored. */
export function parseWorktreeListPorcelain(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      const p = line.slice('worktree '.length).trim();
      if (p) paths.push(p);
    }
  }
  return paths;
}

function normalizePath(p: string): string {
  return path.resolve(p).replace(/\/+$/, '');
}

/** Run `git -C <cwd> worktree list --porcelain` and return every registered
 *  worktree path *other than* `cwd` itself, deduped, with stale entries
 *  (paths that no longer exist on disk) filtered out.
 *
 *  Returns `[]` on any error (not a repo, git missing, timeout) — never
 *  throws. Used to populate `additionalDirectories` at session start so the
 *  CLI's sandbox allows writes into sibling worktrees of the same repo. */
export function discoverWorktrees(
  cwd: string,
  opts?: { exec?: ExecSyncFn; fileExists?: (p: string) => boolean },
): string[] {
  const exec = opts?.exec ?? defaultExec;
  const fileExists = opts?.fileExists ?? ((p: string) => fs.existsSync(p));

  let stdout: string;
  try {
    stdout = exec('git', ['-C', cwd, 'worktree', 'list', '--porcelain'], { cwd, timeout: 2000 });
  } catch {
    return [];
  }

  const cwdNorm = normalizePath(cwd);
  const seen = new Set<string>();
  const siblings: string[] = [];

  for (const raw of parseWorktreeListPorcelain(stdout)) {
    const norm = normalizePath(raw);
    if (norm === cwdNorm) continue;
    if (seen.has(norm)) continue;
    if (!fileExists(norm)) continue;
    seen.add(norm);
    siblings.push(norm);
  }

  return siblings;
}
