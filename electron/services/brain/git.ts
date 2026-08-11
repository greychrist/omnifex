import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Injectable git runner. Matches the pattern in git-branches.ts / git-worktrees.ts. */
export type ExecGit = (args: string[], cwd: string) => Promise<void>;

const defaultExec: ExecGit = async (args, cwd) => {
  await execFileAsync('git', args, { cwd });
};

export interface VaultGit {
  available(): Promise<boolean>;
  init(): Promise<void>;
  /** Returns true when a commit was created, false when unavailable or a no-op. */
  commitAll(message: string): Promise<boolean>;
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

    commitAll(message: string): Promise<boolean> {
      return serialize(async () => {
        try {
          await exec(['add', '-A'], root);
          await exec(['commit', '-q', '-m', message], root);
          return true;
        } catch {
          // Either git is missing or there was nothing staged. Both are
          // non-fatal: the Markdown is already written.
          return false;
        }
      });
    },
  };
}
