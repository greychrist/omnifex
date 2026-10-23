/**
 * Turns a path Claude wrote in a transcript link into something safe to hand
 * `shell.openPath`.
 *
 * Claude writes these paths, so a click must never run anything: an app,
 * script or installer is revealed in Finder instead of opened, and so is any
 * file with an executable bit. Everything else opens in its default app.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PathStat {
  isDirectory(): boolean;
  mode: number;
}

export type OpenPathPlan =
  | { kind: 'open'; path: string }
  | { kind: 'reveal'; path: string }
  | { kind: 'error'; message: string };

/** Extensions macOS may launch or install rather than display. */
const RUNNABLE_EXTENSIONS = new Set([
  '.app', '.command', '.sh', '.bash', '.zsh', '.csh', '.tool', '.terminal',
  '.workflow', '.action', '.pkg', '.mpkg', '.dmg', '.scpt', '.scptd',
  '.applescript', '.py', '.rb', '.pl', '.php', '.js', '.mjs', '.cjs',
  '.jar', '.exe', '.bat', '.prefpane', '.webloc', '.inetloc', '.fileloc',
]);

const LINE_SUFFIX = /(?::\d+){1,2}$/;

export function resolveLinkPath(
  raw: string,
  opts: { cwd?: string; homeDir: string },
): string | null {
  let p = raw.trim();
  if (!p) return null;
  if (p.startsWith('file://')) {
    try {
      p = fileURLToPath(p);
    } catch {
      return null;
    }
  } else {
    try {
      p = decodeURI(p);
    } catch {
      // Not percent-encoded after all; use it as written.
    }
  }
  p = p.replace(LINE_SUFFIX, '');
  if (p === '~' || p.startsWith('~/')) p = path.join(opts.homeDir, p.slice(1));
  if (path.isAbsolute(p)) return path.normalize(p);
  return opts.cwd ? path.resolve(opts.cwd, p) : null;
}

async function defaultStat(p: string): Promise<PathStat | null> {
  try {
    return await fs.promises.stat(p);
  } catch {
    return null;
  }
}

export async function planOpenPath(
  raw: string,
  opts: { cwd?: string; homeDir: string; stat?: (p: string) => Promise<PathStat | null> },
): Promise<OpenPathPlan> {
  const resolved = resolveLinkPath(raw, opts);
  if (!resolved) return { kind: 'error', message: `Can't tell which folder "${raw}" is relative to.` };
  const st = await (opts.stat ?? defaultStat)(resolved);
  if (!st) return { kind: 'error', message: `File not found: ${resolved}` };
  const runnable = RUNNABLE_EXTENSIONS.has(path.extname(resolved).toLowerCase())
    || (!st.isDirectory() && (st.mode & 0o111) !== 0);
  return { kind: runnable ? 'reveal' : 'open', path: resolved };
}
