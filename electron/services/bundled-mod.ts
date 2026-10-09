/**
 * OmniFex's bundled mod (`omnifex-mod/` at the repo root): a Claude Code mod
 * that gives the main session and every subagent a `progress` tool, so the
 * agents popover can draw real step progress. See
 * docs/superpowers/specs/2026-10-09-agent-step-progress-design.md.
 *
 * Sessions load it with `--plugin-dir`, but never from where the app keeps it:
 * the CLI writes `.claude-plugin/types/` and a `tsconfig.json` into any mod
 * dir it loads, and that dir is either the signed app bundle or the dev
 * checkout. So the mod is installed to `<stateDir>/mod/omnifex/` and loaded
 * from there.
 *
 * The source is found the way `remote/webroot.ts` finds `dist-web`, relative
 * to the bundle dir, so this works in main and in the daemon alike (no
 * `electron` import):
 *
 *   repo:      <repo>/.vite/build                      → <repo>/omnifex-mod
 *   packaged:  Contents/Resources/app.asar/.vite/build → Contents/Resources/omnifex-mod
 *
 * The mod is auxiliary. Nothing here may fail a spawn: every failure names no
 * plugin dir, and the session runs as it did before the mod existed.
 */
import fs from 'node:fs';
import path from 'node:path';

import { PROGRESS_MOD_ENABLED_KEY, progressModEnabled } from '../../src/lib/progressModSettings';

/** What the mod is made of. The CLI's own additions beside them are left alone. */
export const BUNDLED_MOD_FILES = [
  '.claude-plugin/plugin.json',
  'hooks/hooks.json',
  'hooks/register.ts',
];

const MANIFEST = '.claude-plugin/plugin.json';

export function candidateBundledModSources(bundleDir: string): string[] {
  return [
    path.resolve(bundleDir, '..', '..', 'omnifex-mod'),
    path.resolve(bundleDir, '..', '..', '..', 'omnifex-mod'),
  ];
}

export function resolveBundledModSource(
  bundleDir: string,
  exists: (p: string) => boolean = fs.existsSync,
): string | null {
  for (const c of candidateBundledModSources(bundleDir)) {
    if (exists(path.join(c, MANIFEST))) return c;
  }
  return null;
}

/**
 * Copy the mod's files to `dest`, rewriting one only when its content
 * differs. Each write goes through a temp file and a rename: main and the
 * daemon both install at startup, and a CLI starting meanwhile must never
 * read half a file. Throws on failure; the caller decides what that costs.
 */
export function installBundledMod(src: string, dest: string): void {
  for (const rel of BUNDLED_MOD_FILES) {
    const from = path.join(src, rel);
    const to = path.join(dest, rel);
    const content = fs.readFileSync(from);
    let current: Buffer | null = null;
    try {
      current = fs.readFileSync(to);
    } catch {
      // Not installed yet.
    }
    if (current && current.equals(content)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const tmp = `${to}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, to);
  }
}

export interface BundledModPluginDirsOptions {
  getSetting: (key: string) => string | null;
  /** The running bundle's directory: `__dirname` in main and the daemon. */
  bundleDir: string;
  /** `defaultStateDir()` — `~/.omnifex`, or `~/.omnifex-dev` for a dev instance. */
  stateDir: string;
  warn?: (message: string, err: unknown) => void;
}

/**
 * The `pluginDirs` closure `createSessionsService` takes. The setting is read
 * at every spawn, so switching it off reaches the next session; the install
 * runs once per process, on the first spawn that wants it.
 */
export function createBundledModPluginDirs(opts: BundledModPluginDirsOptions): () => string[] {
  const warn = opts.warn ?? ((message, err) => { console.warn(`[bundled-mod] ${message}:`, err); });
  let installed: string | null | undefined;

  const install = (): string | null => {
    const src = resolveBundledModSource(opts.bundleDir);
    if (!src) {
      warn('no bundled mod beside the app; sessions start without step progress', opts.bundleDir);
      return null;
    }
    const dest = path.join(opts.stateDir, 'mod', 'omnifex');
    try {
      installBundledMod(src, dest);
      return dest;
    } catch (err) {
      warn(`could not install the bundled mod to ${dest}`, err);
      return null;
    }
  };

  return () => {
    if (!progressModEnabled(opts.getSetting(PROGRESS_MOD_ENABLED_KEY))) return [];
    if (installed === undefined) installed = install();
    return installed ? [installed] : [];
  };
}
