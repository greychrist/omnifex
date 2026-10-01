import { resolveCommand } from './util/spawn';

/**
 * The absolute path of `git`, for every `execFile` that runs it.
 *
 * Never spawn a bare 'git': with the daemon's PATH (/usr/bin eleventh) that was
 * 11 processes per `git status` — ten of them dying before exec, each one more
 * work for syspolicyd. See util/spawn.ts. `/usr/bin/git` is the fallback when
 * PATH has none: on macOS it always exists (the CLT shim), and a missing one
 * fails as ENOENT in one attempt rather than one per PATH entry.
 */
export function gitBinary(): string {
  return resolveCommand('git') ?? '/usr/bin/git';
}
