import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Copy a native module and its transitive deps into the packaged app's node_modules.
function copyNativeModule(buildPath: string, moduleName: string) {
  const src = path.resolve('node_modules', moduleName);
  const dest = path.join(buildPath, 'node_modules', moduleName);
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true });
}

// Copy every installed @anthropic-ai/claude-agent-sdk-* per-platform subpackage
// (as of SDK v0.2.113 the SDK spawns a native binary from one of these). npm
// only installs the optionalDependency that matches the current platform/arch,
// so this typically copies a single subpackage. asarUnpack lifts the binary out
// of asar so spawn() can execute it; see asar.unpack pattern below.
function copySdkPlatformBinaries(buildPath: string) {
  const scopeDir = path.resolve('node_modules', '@anthropic-ai');
  if (!fs.existsSync(scopeDir)) return;
  for (const entry of fs.readdirSync(scopeDir)) {
    if (!entry.startsWith('claude-agent-sdk-')) continue;
    copyNativeModule(buildPath, `@anthropic-ai/${entry}`);
    console.log(`[forge] Copied SDK binary subpackage: @anthropic-ai/${entry}`);
  }
}

const config: ForgeConfig = {
  rebuildConfig: {},
  packagerConfig: {
    name: 'OmniFex',
    executableName: 'omnifex',
    appBundleId: 'com.omnifex.app',
    icon: './icons/icon',
    // Codesign with the self-signed "GreyChrist Local Sign" cert in Greg's
    // login keychain. The cert gives the bundle a stable signing identity
    // hash so macOS TCC grants (App Management, Files & Folders) persist
    // across rebuilds instead of re-prompting every launch.
    //
    // hardenedRuntime: false because macOS Library Validation requires both
    // the loading process and loaded library to share an Apple Developer
    // *Team ID*, not just a code-signing authority. Self-signed certs have
    // `TeamIdentifier=not set`, so even when @electron/osx-sign re-signs
    // both the main binary and the embedded Electron Framework with the
    // same self-signed authority, Library Validation still rejects the
    // pair as "different Team IDs" and dyld kills the app at launch.
    // Disabling hardened runtime turns Library Validation off and the app
    // launches; the cert's identity hash still drives stable TCC.
    //
    // Cert is self-signed → Gatekeeper still treats the build as
    // untrusted → first launch per build still needs right-click → Open.
    // Cleanup plan when Greg buys Developer ID: swap the identity name,
    // re-enable hardened runtime, add notarization config.
    osxSign: {
      identity: 'GreyChrist Local Sign',
      optionsForFile: () => ({ hardenedRuntime: false }),
    },
    extraResource: [
      './assets',
      // Also placed at Contents/Resources/ top-level so macOS NSSound
      // soundNamed: can resolve it for native Notification sound playback.
      './assets/greychrist_success.aiff',
    ],
    asar: {
      // - better-sqlite3: native .node addon
      // - node-pty: native .node addon + spawn-helper (macOS helper binary
      //   that node-pty exec's via posix_spawnp; must be outside asar or
      //   posix_spawnp fails with ENOENT on the .asar.unpacked path)
      // - claude-agent-sdk-*: the SDK's per-platform claude binary, which the
      //   SDK spawns as a subprocess; binaries inside asar can't be exec'd, so
      //   we lift the whole subpackage to app.asar.unpacked.
      unpack: '{**/better-sqlite3/**/*.node,**/node-pty/**/*.node,**/node-pty/**/spawn-helper,**/@anthropic-ai/claude-agent-sdk-*/**}',
    },
    afterCopy: [
      (buildPath, electronVersion, _platform, _arch, callback) => {
        // Copy better-sqlite3 and its deps (bindings, file-uri-to-path)
        // into the packaged app so the externalized require() works.
        try {
          copyNativeModule(buildPath, 'better-sqlite3');
          copyNativeModule(buildPath, 'bindings');
          copyNativeModule(buildPath, 'file-uri-to-path');
          console.log('[forge] Copied better-sqlite3 + deps into package');
          copyNativeModule(buildPath, 'node-pty');
          // node-pty's binding.gyp requires node-addon-api at rebuild time.
          // Without this, electron-rebuild fails with "Cannot find module
          // 'node-addon-api'" inside the packaged app.
          copyNativeModule(buildPath, 'node-addon-api');
          console.log('[forge] Copied node-pty + deps into package');

          // Copy SDK per-platform binary subpackages (see helper for context).
          copySdkPlatformBinaries(buildPath);

          // Rebuild better-sqlite3 for Electron's ABI inside the package.
          // The source node_modules may have Node's ABI (from npm test),
          // so we must rebuild here regardless.
          execSync(
            `npx electron-rebuild -f -v ${electronVersion} -w better-sqlite3,node-pty -m "${buildPath}"`,
            { stdio: 'inherit' },
          );
          console.log('[forge] Rebuilt better-sqlite3 + node-pty for Electron ABI');
        } catch (err) {
          console.error('[forge] Failed to prepare native modules:', err);
          callback(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        callback();
      },
    ],
  },
  makers: [
    { name: '@electron-forge/maker-dmg', config: { format: 'ULFO' } },
    { name: '@electron-forge/maker-squirrel', config: {} },
    { name: '@electron-forge/maker-deb', config: {} },
    { name: '@electron-forge/maker-zip', config: {}, platforms: ['darwin', 'linux'] },
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'electron/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'electron/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [
        { name: 'main_window', config: 'vite.renderer.config.ts' },
      ],
    }),
  ],
};

export default config;
