import { execFile, type ExecFileException, type ExecFileOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { findOnPath } from './path-lookup';

/**
 * The one way to run a user-installed tool by name.
 *
 * Never hand `execFile`/`spawn` a bare command. libuv on macOS cannot use
 * `posix_spawnp` with a custom env, so it walks PATH itself and posix_spawns
 * once per entry until one succeeds — and XNU creates a real process for
 * every miss. Each one inherits OmniFex's provenance tag, and syspolicyd logs
 * `Unable to initialize qtn_proc` + `dispatch_mig_server` for it. A bare
 * `limactl` polled every 5 s was 18 of those lines per tick, ~3.5M a day.
 * System tools that SIP guarantees (`/usr/bin/afplay`, `/bin/launchctl`) are
 * spelled absolute at the call site instead; eslint rejects a bare literal.
 *
 * Cache: a hit is kept until PATH changes, and re-checked with one access()
 * per call so an uninstalled tool is noticed. A miss is never cached — the
 * lookup is a handful of stat calls and no process, so a tool installed after
 * launch is found on the next call.
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

/**
 * The absolute path `name` would run as, or null. Searches `pathEnv`, which
 * defaults to `process.env.PATH` — by the time anything spawns, main and the
 * daemon have both replaced launchd's minimal PATH with the login shell's.
 */
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

/**
 * `execFile(name, …)` with `name` resolved first. Searches `opts.env.PATH`
 * when an env is given — the PATH libuv itself would have walked. Not found
 * fails with an ENOENT-coded error, asynchronously, exactly as `execFile`
 * reports a missing binary, so "not installed" checks keep working.
 */
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
