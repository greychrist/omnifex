/**
 * Ship the daemon's executable: a copy of the Electron stub named `omnifexd`.
 *
 * See electron/remote/daemon-exec.ts for why the daemon needs its own file
 * rather than a runtime title or a symlink. The stub is ~50 KB — it loads the
 * Electron Framework beside it and nothing else — so a copy costs nothing.
 *
 * Runs from the packager's `afterCopy` hook, which is handed the
 * `Contents/Resources/app` directory of the staging bundle while the stub is
 * still called `Electron` (the packager renames it to `executableName` later
 * and leaves other files in MacOS/ alone). Signing walks Contents/ afterwards
 * and picks the copy up as a binary; `signing/index.ts` gives it the main
 * entitlements.
 *
 * File access is injected so the paths are testable without a bundle.
 */
import { chmodSync, copyFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DAEMON_EXECUTABLE } from '../electron/remote/daemon-exec';

export interface StubFs {
  copyFileSync(from: string, to: string): void;
  chmodSync(path: string, mode: number): void;
  statSync(path: string): { mode: number };
}

const realFs: StubFs = { copyFileSync, chmodSync, statSync };

/** `<bundle>.app/Contents/Resources/app` → `<bundle>.app`. */
export function appBundleFromResourcesApp(resourcesApp: string): string {
  return resolve(resourcesApp, '..', '..', '..');
}

export function daemonStubPaths(appBundle: string, sourceExecutable: string): { from: string; to: string } {
  const macos = join(appBundle, 'Contents', 'MacOS');
  return { from: join(macos, sourceExecutable), to: join(macos, DAEMON_EXECUTABLE) };
}

/** Copy the stub and return where it landed. Throws if the source is missing — a build without the daemon is not a release. */
export function installDaemonStub(appBundle: string, sourceExecutable: string, fs: StubFs = realFs): string {
  const { from, to } = daemonStubPaths(appBundle, sourceExecutable);
  fs.copyFileSync(from, to);
  fs.chmodSync(to, fs.statSync(from).mode);
  return to;
}
