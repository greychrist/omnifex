import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    // Main-process entries reach into src/ for shared pure TS (protocol,
    // classifier); those files use the renderer's `@/` alias.
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  build: {
    rollupOptions: {
      // `ws` too: bundling it rewrites the module object its optional native
      // fallback (bufferutil) is looked up on, and the daemon then throws
      // `bufferUtil.unmask is not a function` on the first inbound frame. It is
      // a runtime dependency, so it ships in node_modules either way.
      external: ['better-sqlite3', 'node-pty', 'ws', 'web-push'],
    },
  },
});
