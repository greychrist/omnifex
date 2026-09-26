import fs from 'node:fs';
import path from 'node:path';

/**
 * The absolute path of `git`, for every `execFile` that runs it.
 *
 * Never spawn a bare 'git': on macOS libuv resolves it by calling posix_spawn
 * once per PATH entry until one succeeds, and XNU creates a process for every
 * miss. With the daemon's PATH (/usr/bin eleventh) that was 11 processes per
 * `git status` — ten of them dying before exec, each one more work for
 * syspolicyd. Searching PATH here costs a few stat calls, once.
 */
export function resolveGitBinary(pathEnv: string | undefined): string {
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'git');
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* not here */
    }
  }
  return 'git';
}

let cached: { pathEnv: string | undefined; bin: string } | null = null;

/** `resolveGitBinary(process.env.PATH)`, re-resolved only when PATH changes. */
export function gitBinary(): string {
  const pathEnv = process.env.PATH;
  if (cached && cached.pathEnv === pathEnv) return cached.bin;
  cached = { pathEnv, bin: resolveGitBinary(pathEnv) };
  return cached.bin;
}
