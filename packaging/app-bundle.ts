/**
 * The shape of `OmniFex.app`, as pure functions the package script and its
 * tests share.
 *
 *   Contents/
 *     Info.plist
 *     MacOS/OmniFex              the Swift app (macos/)
 *     MacOS/omnifexd             Node — the executable's own name is what
 *                                names the daemon process (process.title would
 *                                register it with LaunchServices and bounce
 *                                the Dock forever; see 0.4.158)
 *     Resources/icon.icns
 *     Resources/greychrist_success.aiff
 *     Resources/app/package.json { name, version } — the daemon's version
 *     Resources/app/build/       omnifex-server.js, brain-mcp.js
 *     Resources/app/node_modules the packages the bundles leave external
 *     Resources/dist-web/        the renderer
 *     Resources/omnifex-mod/     the bundled Claude Code mod
 *
 * `build/` is two levels under `Resources/`, so `webroot.ts` and
 * `bundled-mod.ts` find `dist-web/` and `omnifex-mod/` at `build/../..` —
 * the same relative step that reaches the repo root from `.vite/build`.
 */
import { join } from 'node:path';

export const APP_NAME = 'OmniFex';
export const BUNDLE_ID = 'com.omnifex.app';
export const MINIMUM_MACOS = '27.0';

/** Packages the bundles leave external that are native, with their own runtime deps. */
export const NATIVE_MODULES = ['better-sqlite3', 'bindings', 'file-uri-to-path', 'node-pty'];
/** Pure-JS externals, copied with their whole dependency tree (module-tree.ts). */
export const JS_EXTERNAL_MODULES = ['ws', 'web-push'];

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function infoPlist(opts: { name: string; bundleId: string; version: string }): string {
  const str = (k: string, v: string) => `  <key>${k}</key>\n  <string>${xml(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${str('CFBundleName', opts.name)}
${str('CFBundleDisplayName', opts.name)}
${str('CFBundleIdentifier', opts.bundleId)}
${str('CFBundleExecutable', APP_NAME)}
${str('CFBundleIconFile', 'icon')}
${str('CFBundlePackageType', 'APPL')}
${str('CFBundleInfoDictionaryVersion', '6.0')}
${str('CFBundleShortVersionString', opts.version)}
${str('CFBundleVersion', opts.version)}
${str('LSMinimumSystemVersion', MINIMUM_MACOS)}
${str('LSApplicationCategoryType', 'public.app-category.developer-tools')}
${str('NSPrincipalClass', 'NSApplication')}
${str('NSHumanReadableCopyright', 'Copyright © GreyChrist, LLC')}
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
    <key>NSAllowsArbitraryLoadsInWebContent</key>
    <true/>
  </dict>
</dict>
</plist>
`;
}

export interface BundleLayout {
  app: string;
  contents: string;
  macos: string;
  executable: string;
  node: string;
  resources: string;
  appRoot: string;
  build: string;
  nodeModules: string;
  webRoot: string;
  mod: string;
}

export function bundleLayout(app: string): BundleLayout {
  const contents = join(app, 'Contents');
  const macos = join(contents, 'MacOS');
  const resources = join(contents, 'Resources');
  const appRoot = join(resources, 'app');
  return {
    app,
    contents,
    macos,
    executable: join(macos, APP_NAME),
    node: join(macos, 'omnifexd'),
    resources,
    appRoot,
    build: join(appRoot, 'build'),
    nodeModules: join(appRoot, 'node_modules'),
    webRoot: join(resources, 'dist-web'),
    mod: join(resources, 'omnifex-mod'),
  };
}

/** Mach-O (32/64, either byte order) or a universal binary, by magic. */
export function isMachO(header: Uint8Array): boolean {
  if (header.length < 4) return false;
  const magic = ((header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3]) >>> 0;
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic);
}

/**
 * Whether a file of a native module ships. The addon, its JS and its
 * manifest do; its C sources, build intermediates, test fixtures and other
 * platforms' prebuilds do not — together they were most of the 50 MB the two
 * modules occupy in node_modules.
 */
export function shipsNativeFile(moduleName: string, rel: string): boolean {
  if (moduleName === 'better-sqlite3') {
    return rel === 'package.json' || rel.startsWith('lib/') || rel === 'build/Release/better_sqlite3.node';
  }
  if (moduleName === 'node-pty') {
    return (
      rel === 'package.json' ||
      rel.startsWith('lib/') ||
      rel === 'build/Release/pty.node' ||
      // posix_spawn'd by pty.node for every terminal; missing, every spawn
      // fails with ENOENT.
      rel === 'build/Release/spawn-helper'
    );
  }
  return true;
}

/**
 * Codesign order: nested code first, deepest first, then the bundle itself.
 * The bundle's own signature seals the main executable, so it is never
 * signed on its own.
 */
export function signingOrder(app: string, machOFiles: string[]): string[] {
  const main = join(app, 'Contents', 'MacOS', APP_NAME);
  const nested = machOFiles
    .filter((f) => f !== main)
    .sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b));
  return [...nested, app];
}
