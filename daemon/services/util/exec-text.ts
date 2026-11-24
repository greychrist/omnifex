import { execFile, type ExecFileOptions } from 'node:child_process';

/**
 * Run an already-resolved binary and resolve its stdout — the async form of
 * `execFileSync(bin, args, { encoding: 'utf8' })`.
 *
 * The daemon is one event loop serving every live session's stream, so a sync
 * spawn on a request path freezes all of them for as long as the child runs.
 * `binaryPath` must be absolute (see util/spawn.ts for resolving a name).
 *
 * stdin is closed at once, as `execFileSync` does when given no `input`: the
 * Claude CLI in `-p` mode reads a piped stdin to EOF before it answers, so
 * leaving the pipe open would hang it until the timeout.
 */
export function execFileText(
  binaryPath: string,
  args: readonly string[],
  opts: ExecFileOptions & { timeout: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(binaryPath, args, { ...opts, encoding: 'utf8' }, (err: Error | null, stdout: string) => {
      if (err) reject(err);
      else resolve(stdout);
    });
    child?.stdin?.end();
  });
}

/** `<binary> --version`, trimmed; null on any failure (missing, non-zero exit, timeout). */
export async function probeBinaryVersion(binaryPath: string, timeoutMs = 5000): Promise<string | null> {
  try {
    return (await execFileText(binaryPath, ['--version'], { timeout: timeoutMs })).trim();
  } catch {
    return null;
  }
}
