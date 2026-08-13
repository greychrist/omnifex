import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    include: [
      'electron/__tests__/**/*.test.ts',
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
    ],
    environment: 'node',
    // `default` still prints to the terminal; `json` leaves a record behind.
    //
    // Terminal output is the only account of a run, and it is routinely piped
    // through `tail`. A run that reported "1 failed" with the name scrolled or
    // filtered away was unrecoverable — the only way "back" was another run,
    // which for a load-dependent flake samples a new outcome rather than
    // replaying the old one. This file answers "which test failed?" without
    // re-running anything.
    reporters: ['default', 'json'],
    outputFile: { json: './.vitest/last-run.json' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      // App bootstrap and preload run in the Electron runtime and are not
      // meaningful to unit-test in isolation; exclude from coverage.
      exclude: [
        'electron/__tests__/**',
        'electron/main.ts',
        'electron/preload.ts',
        // Thin process entry over mcp-tools.ts, which is fully tested.
        // Exercising it means spawning a stdio server; the smoke test in the
        // Plan 5 doc covers that end to end.
        'electron/brain-mcp.ts',
        // vitest defaults still apply (node_modules, dist, .vite, etc.)
      ],
      // Coverage is reported (via `npm run test:coverage`) but not gated.
      // Hard thresholds used to trip release builds even when the diff
      // barely moved coverage; since GitHub Actions isn't running anymore
      // (solo project, local-only releases), there's no point enforcing.
    },
  },
});
