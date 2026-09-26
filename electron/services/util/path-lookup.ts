import fs from 'node:fs';
import path from 'node:path';

/**
 * The first executable `name` on `pathEnv`, or null — what `which` answers,
 * for the cost of a few stat calls instead of a shell and a `which` process.
 *
 * Resolve once and spawn by the absolute path it returns. A bare name makes
 * libuv on macOS posix_spawn once per PATH entry until one succeeds, and XNU
 * creates a process — assessed by syspolicyd — for every miss.
 */
export function findOnPath(name: string, pathEnv: string | undefined): string | null {
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}
