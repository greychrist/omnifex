import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Injectable probe, resolving with the command's stdout. Matches the `ExecGit`
 *  pattern in git.ts so this is testable without a live file provider. */
export type ExecCount = (root: string) => Promise<string>;

const defaultExec: ExecCount = async (root) => {
  // The path arrives as `$0` rather than interpolated into the script: a vault
  // root is user-supplied and may contain spaces, quotes or `$`.
  const { stdout } = await execFileAsync(
    '/bin/sh',
    ['-c', 'find "$0" -flags +dataless -print | wc -l', root],
    { timeout: 10_000 },
  );
  return stdout;
};

/**
 * How many files under `root` a macOS file provider has evicted to stubs.
 *
 * `SF_DATALESS` marks a file whose metadata is local but whose contents are
 * not: the first read blocks on a network fetch. Measured cost on iCloud Drive
 * with Optimize Mac Storage on is ~0.6s per file, which is invisible for one
 * note and fatal for a vault — `git add -A` walks every tracked file AND reads
 * the matching loose object out of `.git`, so a few hundred stubs turn one
 * commit into minutes with the app apparently hung and nothing logged.
 *
 * Every modern sync client (iCloud Drive, Dropbox, OneDrive, Google Drive)
 * goes through NSFileProvider and sets the same flag, so this one probe covers
 * all of them without naming any.
 *
 * Null means "not determined", never "none": the flag is a Darwin concept, and
 * a probe that cannot run must not be reportable as a clean bill of health.
 * The Brain is auxiliary — this never throws into a caller.
 */
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
