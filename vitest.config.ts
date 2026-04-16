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
      // Coverage is reported (via `npm run test:coverage`) but not gated.
      // Hard thresholds used to trip release builds even when the diff
      // barely moved coverage; since GitHub Actions isn't running anymore
      // (solo project, local-only releases), there's no point enforcing.
    },
  },
});
