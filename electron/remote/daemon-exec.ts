/**
 * Which executable the daemon runs as.
 *
 * The daemon is the app's own Electron binary run as node, so macOS names its
 * process after that file: a second `omnifex` in Activity Monitor and `ps`,
 * indistinguishable from the app. Renaming at runtime is worse — on macOS
 * `process.title` makes libuv check the process in with LaunchServices as a
 * launching foreground app so the new name shows, and a process that never
 * opens a window then bounces in the Dock (0.4.158). The only name macOS
 * honours without side effects is the executed file's own, so the bundle
 * ships a second copy of the small Electron stub as `omnifexd`
 * (packaging/daemon-stub.ts) and the daemon is launched through it. A
 * symlink does not do: the kernel resolves it and names the process after
 * the target.
 *
 * Pure so the path logic is testable.
 */
import { basename, dirname, join } from 'node:path';

/** `executableName` in forge.config.ts. */
export const APP_EXECUTABLE = 'omnifex';
/** The daemon stub beside it, the Unix way (`sshd`, `launchd`). */
export const DAEMON_EXECUTABLE = 'omnifexd';

/**
 * The daemon stub beside `appExec` when the bundle ships one; otherwise
 * `appExec` itself — a dev Electron has no stub and runs the daemon under
 * its own name.
 */
export function daemonExecPath(appExec: string, exists: (path: string) => boolean): string {
  const stub = join(dirname(appExec), DAEMON_EXECUTABLE);
  return exists(stub) ? stub : appExec;
}

/**
 * The app executable for whichever of the two `execPath` is. The daemon
 * registers the Brain MCP server as a command the CLI spawns, and that must
 * be the app's executable — the same path the app registers — or the two
 * would rewrite each other's registration on every launch.
 */
export function appExecPath(execPath: string): string {
  return basename(execPath) === DAEMON_EXECUTABLE ? join(dirname(execPath), APP_EXECUTABLE) : execPath;
}
