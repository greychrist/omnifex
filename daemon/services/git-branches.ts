import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { gitBinary } from './git-binary';

const execFileAsync = promisify(execFile);

export async function listBranches(projectPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      gitBinary(),
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
