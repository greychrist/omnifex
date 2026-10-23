/**
 * The renderer: built into `dist-web/`, which the daemon serves at `/` to
 * every client — the Mac app's window and Safari on the iPad alike. One
 * bundle, two hosts: `src/lib/remote/bootstrap.ts` tells them apart at
 * runtime by whether the native bridge is present. `npm run dev` serves the
 * same config for the dev app.
 *
 * `publicDir: web/public/` holds the PWA manifest, the service worker and the
 * icon, which only the browser uses.
 *
 * The one define is `__APP_VERSION__`. A web page is served by one specific
 * daemon build, so it has a real version, and the shim answers
 * `get_app_version` with it on the web (the Mac app answers it itself).
 * Without it the shim replied with the literal string `web`, which never
 * equals a version number, so the daemon popover's mismatch warning was on
 * permanently.
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
  server: {
    // `npm start` points the dev app here, so a fixed port.
    port: 5173,
    strictPort: true,
    watch: {
      // Test output, not source. `npm run test:coverage` writes thousands of
      // HTML files under coverage/, and with the dev server running each one
      // is a file-change event — one run produced 2,524 page reloads.
      ignored: ['**/coverage/**', '**/.vitest/**', '**/out/**', '**/dist-web/**', '**/macos/.build/**'],
    },
  },
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
