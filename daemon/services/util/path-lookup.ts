import fs from 'node:fs';
import path from 'node:path';

/** Spawn by the absolute path this returns: on macOS a bare name posix_spawns once per PATH miss. */
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
