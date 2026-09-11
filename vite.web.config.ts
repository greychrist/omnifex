/**
 * The web client: the SAME renderer, built to be served by the daemon at `/`.
 *
 * Differences from the Electron renderer build are deliberately few:
 *  - `base: '/'` (served over HTTP, not loaded from file://);
 *  - `outDir: dist-web/`, which the daemon serves as `webRoot`;
 *  - `publicDir: web/public/`, holding the PWA manifest, the service worker
 *    and the icon — files the Electron build has no use for.
 *
 * No web-specific entry: `src/lib/remote/bootstrap.ts` detects the absence of
 * the preload bridge at runtime and installs the WebSocket shim against
 * `location.host`. One bundle, two hosts.
 *
 * The one define is `__APP_VERSION__`. A web page is served by one specific
 * daemon build, so it has a real version, and the shim answers
 * `get_app_version` with it. The Electron renderer has no such define — it
 * asks main over IPC — and used to share that fate here: the shim replied
 * with the literal string `web`, which never equals a version number, so the
 * daemon popover's mismatch warning was on permanently.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  plugins: [react()],
  base: '/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  publicDir: 'web/public',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'ui-vendor': [
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-select',
            '@radix-ui/react-tooltip',
          ],
          'editor-vendor': ['@uiw/react-md-editor'],
          'syntax-vendor': ['react-syntax-highlighter'],
          utils: ['date-fns', 'clsx', 'tailwind-merge'],
        },
      },
    },
  },
});
