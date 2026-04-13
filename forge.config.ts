import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';
import fs from 'node:fs';
import path from 'node:path';

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
    name: 'GreyChrist',
    executableName: 'greychrist',
    appBundleId: 'com.greychrist.app',
    icon: './icons/icon',
    asar: {
      unpack: '**/better-sqlite3/**/*.node',
    },
    afterCopy: [
      (buildPath, _electronVersion, _platform, _arch, callback) => {
        // Copy better-sqlite3 and its deps (bindings, file-uri-to-path)
        // into the packaged app so the externalized require() works.
        try {
          copyNativeModule(buildPath, 'better-sqlite3');
          copyNativeModule(buildPath, 'bindings');
          copyNativeModule(buildPath, 'file-uri-to-path');
          console.log('[forge] Copied better-sqlite3 + deps into package');
        } catch (err) {
          console.error('[forge] Failed to copy native modules:', err);
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
