import { resolveCommand } from './util/spawn';

/** Never spawn a bare `git`: a process per PATH miss (see util/spawn.ts). `/usr/bin/git` always exists on macOS. */
export function gitBinary(): string {
  return resolveCommand('git') ?? '/usr/bin/git';
}
