import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { gitBinary } from '../git-binary';

const execFileAsync = promisify(execFile);

export type ExecGit = (args: string[], cwd: string) => Promise<string>;

const defaultExec: ExecGit = async (args, cwd) => {
  const { stdout } = await execFileAsync(gitBinary(), args, { cwd });
  return stdout;
};

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
  // Serialize git calls: interleaved add/commit pairs misattribute files to another run's message.
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
          // No rev-parse pre-check: it walks UP, so a vault inside another repo would stage the outer repo.
          await exec(['init', '-q'], root);
        } catch {
          // A missing git must not fail a write whose Markdown already landed.
        }
      });
    },

    commitAll(message: string): Promise<CommitResult> {
      return serialize(async () => {
        try {
          await exec(['add', '-A'], root);
          // `commit` exits non-zero for both an empty index and a real failure, so ask `status`.
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
