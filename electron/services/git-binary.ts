import { findOnPath } from './util/path-lookup';

/**
 * The absolute path of `git`, for every `execFile` that runs it.
 *
 * Never spawn a bare 'git': with the daemon's PATH (/usr/bin eleventh) that was
 * 11 processes per `git status` — ten of them dying before exec, each one more
 * work for syspolicyd. See util/path-lookup.ts.
 */
export function resolveGitBinary(pathEnv: string | undefined): string {
  return findOnPath('git', pathEnv) ?? 'git';
}

let cached: { pathEnv: string | undefined; bin: string } | null = null;

/** `resolveGitBinary(process.env.PATH)`, re-resolved only when PATH changes. */
export function gitBinary(): string {
  const pathEnv = process.env.PATH;
  if (cached && cached.pathEnv === pathEnv) return cached.bin;
  cached = { pathEnv, bin: resolveGitBinary(pathEnv) };
  return cached.bin;
}
