import { spawn as nodeSpawn } from 'node:child_process';

export function resolveAppBundlePath(execPath: string): string | null {
  const marker = '.app/';
  const idx = execPath.indexOf(marker);
  if (idx === -1) return null;
  return execPath.slice(0, idx + marker.length - 1);
}

export interface LaunchOptions {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  execPath: string;
  spawn?: (cmd: string, args: string[]) => void;
}

export interface LaunchResult {
  ok: boolean;
  reason?: string;
}

export function launchNewInstance(opts: LaunchOptions): LaunchResult {
  if (opts.platform !== 'darwin') {
    return { ok: false, reason: 'New Window is only supported on macOS' };
  }
  if (!opts.isPackaged) {
    return { ok: false, reason: 'New Window is only available in packaged builds' };
  }
  const bundle = resolveAppBundlePath(opts.execPath);
  if (!bundle) {
    return { ok: false, reason: 'Could not locate the .app bundle' };
  }
  const spawnFn =
    opts.spawn ??
    ((cmd, args) => {
      const child = nodeSpawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.unref();
    });
  spawnFn('open', ['-n', bundle]);
  return { ok: true };
}
