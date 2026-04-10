import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['electron/__tests__/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      // App bootstrap and preload run in the Electron runtime and are not
      // meaningful to unit-test in isolation; exclude from coverage.
      exclude: [
        'electron/__tests__/**',
        'electron/main.ts',
        'electron/preload.ts',
        // vitest defaults still apply (node_modules, dist, .vite, etc.)
      ],
      // Coverage ratchet. Baseline at enablement (2026-04-10): 94.06% lines,
      // 97.56% functions, 73.99% branches, 92.52% statements. Thresholds are
      // set ~4% below baseline to give headroom for new code without letting
      // coverage silently regress. Raise these as coverage climbs.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 70,
        statements: 90,
      },
    },
  },
});
