import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ExecCount = (root: string) => Promise<string>;

const defaultExec: ExecCount = async (root) => {
  // Pass the user-supplied path as $0, never interpolated into the script.
  const { stdout } = await execFileAsync(
    '/bin/sh',
    ['-c', 'find "$0" -flags +dataless -print | wc -l', root],
    { timeout: 10_000 },
  );
  return stdout;
};

/** Counts SF_DATALESS stubs (any NSFileProvider client). Null means "not determined", never "none"; never throws. */
export async function countOffloadedFiles(
  root: string,
  exec: ExecCount = defaultExec,
  platform: NodeJS.Platform = process.platform,
): Promise<number | null> {
  if (platform !== 'darwin') return null;
  let raw: string;
  try {
    raw = await exec(root);
  } catch {
    return null;
  }
  const count = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(count) && count >= 0 ? count : null;
}
