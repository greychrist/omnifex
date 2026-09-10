/**
 * The web client: the SAME renderer, built to be served by the daemon at `/`.
 *
 * Differences from the Electron renderer build are deliberately few:
 *  - `base: '/'` (served over HTTP, not loaded from file://);
 *  - `outDir: dist-web/`, which the daemon serves as `webRoot`;
 *  - `publicDir: web/public/`, holding the PWA manifest, the service worker
 *    and the icon — files the Electron build has no use for.
 *
 * No web-specific entry or define: `src/lib/remote/bootstrap.ts` detects the
 * absence of the preload bridge at runtime and installs the WebSocket shim
 * against `location.host`. One bundle, two hosts.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  base: '/',
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
