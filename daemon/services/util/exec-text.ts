import { execFile, type ExecFileOptions } from 'node:child_process';

/**
 * Async: a sync spawn freezes every live session on the daemon's one event loop.
 * stdin is closed at once: `claude -p` reads a piped stdin to EOF, so an open pipe hangs it.
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

export async function probeBinaryVersion(binaryPath: string, timeoutMs = 5000): Promise<string | null> {
  try {
    return (await execFileText(binaryPath, ['--version'], { timeout: timeoutMs })).trim();
  } catch {
    return null;
  }
}
