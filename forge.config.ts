import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { optionsForFile, osxNotarizeConfig } from './signing';
import { dmgArtifacts, notarizeDmg } from './signing/dmg';

// Copy a native module and its transitive deps into the packaged app's node_modules.
function copyNativeModule(buildPath: string, moduleName: string) {
  const src = path.resolve('node_modules', moduleName);
  const dest = path.join(buildPath, 'node_modules', moduleName);
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true });
}

const config: ForgeConfig = {
  rebuildConfig: {},
  packagerConfig: {
    name: 'OmniFex',
    executableName: 'omnifex',
    appBundleId: 'com.omnifex.app',
    icon: './icons/icon',
    // Codesign with the Developer ID Application cert (team 37YG3HV4BV).
    //
    // `identity` is left unset so @electron/osx-sign discovers the Developer
    // ID Application cert from the keychain itself — for a non-MAS build it
    // looks for that cert type specifically, so it will not pick up an
    // "Apple Development" cert by mistake. Set APPLE_SIGNING_IDENTITY to
    // force a particular one when the keychain holds several.
    //
    // hardenedRuntime is on (see signing/index.ts): the notary service
    // rejects any submission containing an executable signed without it.
    // This was previously off because the self-signed cert had
    // `TeamIdentifier=not set`, so Library Validation saw the main binary
    // and the embedded Electron Framework as different teams and dyld
    // killed the app at launch. A real Developer ID gives both the same
    // Team ID, so that failure mode is gone.
    //
    // Entitlements are ours rather than osx-sign's defaults, which grant
    // only allow-jit plus camera/mic/bluetooth/USB — too little of what
    // Electron needs and several things OmniFex never touches.
    osxSign: {
      identity: process.env.APPLE_SIGNING_IDENTITY,
      optionsForFile,
    },
    // Opt-in via OMNIFEX_NOTARIZE=1 so local packaging doesn't block on
    // Apple's notary queue. Credentials come from a keychain profile.
    osxNotarize: osxNotarizeConfig(),
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
      unpack: '{**/better-sqlite3/**/*.node,**/node-pty/**/*.node,**/node-pty/**/spawn-helper}',
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
  hooks: {
    // maker-dmg wraps the already-notarized .app in a brand new disk image
    // that carries no signature of its own, so the container fails Gatekeeper
    // even though the app inside passes. Sign / notarize / staple it here.
    // Same OMNIFEX_NOTARIZE gate as osxNotarize — local builds skip it.
    postMake: async (_forgeConfig, makeResults) => {
      const notarize = osxNotarizeConfig();
      if (!notarize) return makeResults;

      for (const dmg of dmgArtifacts(makeResults)) {
        await notarizeDmg(
          dmg,
          {
            keychainProfile: notarize.keychainProfile,
            identity: process.env.APPLE_SIGNING_IDENTITY,
          },
          {
            run: (cmd, args) =>
              execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }),
            log: (message) => { console.log(message); },
          },
        );
      }

      return makeResults;
    },
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
        // The Brain MCP server. Not loaded by the app: the Claude CLI spawns
        // it as `process.execPath` with ELECTRON_RUN_AS_NODE=1, which is what
        // keeps better-sqlite3 on the Electron ABI it was built for.
        { entry: 'electron/brain-mcp.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'electron/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [
        { name: 'main_window', config: 'vite.renderer.config.ts' },
      ],
    }),
  ],
};

export default config;
