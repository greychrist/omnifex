import { execFile, type ExecFileException, type ExecFileOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { findOnPath } from './path-lookup';

/**
 * Never hand execFile/spawn a bare command: libuv on macOS posix_spawns once per PATH entry, and every miss is a
 * real process plus syspolicyd log lines (~3.5M a day). Misses are never cached, so a later install is found.
 */

const cache = new Map<string, { pathEnv: string | undefined; bin: string }>();

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveCommand(name: string, pathEnv: string | undefined = process.env.PATH): string | null {
  if (path.isAbsolute(name)) return name;
  const hit = cache.get(name);
  if (hit && hit.pathEnv === pathEnv && isExecutable(hit.bin)) return hit.bin;
  cache.delete(name);
  const bin = findOnPath(name, pathEnv);
  if (bin) cache.set(name, { pathEnv, bin });
  return bin;
}

export type ExecFileOnPathCallback = (
  err: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;

/** Not found fails with an async ENOENT, exactly as execFile would, so "not installed" checks keep working. */
export function execFileOnPath(
  name: string,
  args: readonly string[],
  opts: ExecFileOptions,
  callback: ExecFileOnPathCallback,
): void {
  const bin = resolveCommand(name, opts.env ? opts.env.PATH : process.env.PATH);
  if (!bin) {
    const err: ExecFileException = new Error(`spawn ${name} ENOENT`);
    err.code = 'ENOENT';
    err.syscall = `spawn ${name}`;
    err.path = name;
    process.nextTick(() => { callback(err, '', ''); });
    return;
  }
  execFile(bin, args, { ...opts, encoding: 'utf8' }, (err, stdout, stderr) => {
    callback(err, stdout, stderr);
  });
}
