import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Injectable git runner, resolving with the command's stdout. Matches the
 *  pattern in git-branches.ts / git-worktrees.ts. */
export type ExecGit = (args: string[], cwd: string) => Promise<string>;

const defaultExec: ExecGit = async (args, cwd) => {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
};

/**
 * Why this is a discriminated result and not a boolean: "nothing to commit" and
 * "the commit failed" are the same exit status from git, and collapsing them
 * means a vault whose `.git` is corrupt, unwritable or full looks exactly like
 * a vault where the user changed nothing. That silence is harmless while
 * nothing displays versioning state; it becomes a lie the moment the Brain tab
 * claims a vault is versioned.
 */
export type CommitResult =
  | { ok: true }
  | { ok: false; reason: 'nothing-to-commit' }
  | { ok: false; reason: 'failed'; message: string };

export interface VaultGit {
  available(): Promise<boolean>;
  init(): Promise<void>;
  commitAll(message: string): Promise<CommitResult>;
}

export function createVaultGit(root: string, exec: ExecGit = defaultExec): VaultGit {
  // Serialises every git invocation. Concurrent index runs must not interleave
  // add/commit pairs, which would attribute one run's files to another's message.
  let lock: Promise<void> = Promise.resolve();

  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = lock.then(fn, fn);
    lock = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    async available(): Promise<boolean> {
      try {
        await exec(['--version'], root);
        return true;
      } catch {
        return false;
      }
    },

    init(): Promise<void> {
      return serialize(async () => {
        try {
          // `git init` is idempotent, and it correctly creates a NESTED repo
          // when the vault sits inside another repository. Do not pre-check
          // with `rev-parse --git-dir`: that walks UP the tree, so a vault
          // placed inside an existing repo would look already-initialised, and
          // every later `git add -A` would stage the OUTER repo's whole working
          // tree — committing the user's unrelated work under a Brain message.
          await exec(['init', '-q'], root);
        } catch {
          // Versioning is a safety net, not a hard dependency. A missing git
          // binary must not fail a write whose Markdown already landed.
        }
      });
    },

    commitAll(message: string): Promise<CommitResult> {
      return serialize(async () => {
        try {
          await exec(['add', '-A'], root);
          // Ask git what is staged rather than inferring it from the exit
          // status of `commit`. `commit` exits non-zero for an empty index AND
          // for a genuine failure, so its status alone cannot distinguish the
          // two — which is the whole point of this method's return type.
          const status = await exec(['status', '--porcelain'], root);
          if (status.trim() === '') return { ok: false, reason: 'nothing-to-commit' };
          await exec(['commit', '-q', '-m', message], root);
          return { ok: true };
        } catch (err) {
          return { ok: false, reason: 'failed', message: (err as Error).message };
        }
      });
    },
  };
}
