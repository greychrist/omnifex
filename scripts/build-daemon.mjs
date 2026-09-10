// Build the OmniFex Remote daemon entry on its own, outside Electron Forge.
//
// Forge builds every entry in forge.config.ts (including this one) as part of
// `npm start` / `npm run package`, so a packaged app ships the daemon. This
// script exists for development and for `omnifex-server install` on a machine
// running from the repo: it produces .vite/build/omnifex-server.js with the
// same shape forge would — CommonJS, node builtins external, the two native
// modules external — without launching the app.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtins = builtinModules.flatMap((m) => [m, `node:${m}`]);

await build({
  configFile: false,
  root,
  logLevel: 'info',
  resolve: {
    alias: { '@': path.join(root, 'src') },
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    outDir: '.vite/build',
    emptyOutDir: false,
    copyPublicDir: false,
    minify: false,
    sourcemap: true,
    lib: {
      entry: path.join(root, 'electron/omnifex-server.ts'),
      fileName: () => 'omnifex-server.js',
      formats: ['cjs'],
    },
    rollupOptions: {
      // Keep in step with vite.main.config.ts: `ws` must stay external or its
      // bufferutil fallback breaks inside the bundle.
      external: [...builtins, 'electron', 'electron/main', 'better-sqlite3', 'node-pty', 'ws'],
    },
  },
});
