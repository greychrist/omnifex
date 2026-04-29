import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * List local branch names for a git repo at `projectPath`.
 * Returns [] if the directory is not a repo or git is not installed.
 * Output is sorted alphabetically (git's default for for-each-ref refs/heads).
 */
export async function listBranches(projectPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['for-each-ref', 'refs/heads', '--format=%(refname:short)'],
      { cwd: projectPath },
    );
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .sort();
  } catch {
    return [];
  }
}
