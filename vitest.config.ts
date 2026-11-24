import { defineConfig } from 'vitest/config';
import path from 'path';

import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  // Mirrors vite.web.config.ts.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    include: [
      'daemon/__tests__/**/*.test.ts',
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
    ],
    environment: 'node',
    // Node 26's Web Storage makes `localStorage` an undefined getter that jsdom won't overwrite.
    execArgv: ['--no-webstorage'],
    // `json` records which test failed, so a flake is never re-run to recover its name.
    reporters: ['default', 'json'],
    outputFile: { json: './.vitest/last-run.json' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      exclude: [
        'daemon/__tests__/**',
        // Thin stdio entry over the tested mcp-tools.ts.
        'daemon/brain-mcp.ts',
      ],
      // Reported, not gated: hard thresholds tripped release builds on diffs that barely moved coverage.
    },
  },
});
