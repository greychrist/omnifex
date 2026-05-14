// eslint flat config (eslint 9 + typescript-eslint v8) for OmniFex.
//
// Goals (per the Tier S decision in CHANGELOG / session notes):
//   * Catch React effect-deps drift before it ships
//     (`react-hooks/exhaustive-deps`).
//   * Catch async-ish bugs the type-checker can't see
//     (`no-floating-promises`, `no-misused-promises`).
//   * Catch silent fall-throughs in discriminated-union switches
//     (`switch-exhaustiveness-check`) — the failure mode that hid
//     the lost-`task_updated` payload bug.
//   * Honor the 30-some `// eslint-disable` comments already in the
//     tree by actually running an eslint that recognizes them.
//
// `projectService: true` is the modern way to give typed-linting rules
// access to type info; it auto-finds the nearest `tsconfig.json` per
// file and naturally covers both the renderer (tsconfig.json) and main
// process (tsconfig.electron.json) projects.
//
// Rule policy (see "Why these are off" comments below for each):
// strict-type-checked + stylistic-type-checked are the BASE. We then
// turn off the rules that produce 100s of low-signal stylistic
// findings on this codebase, while keeping every rule that catches
// a real bug class. The intent is "eslint passes clean, every report
// is worth investigating," not "every strict rule is non-negotiable."

import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default defineConfig(
  // Ignore patterns first — anything matched here skips ALL configs below.
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist-electron/**',
      '.vite/**',
      'out/**',
      'coverage/**',
      // Generated/Vite/Forge/Electron output that doesn't belong in lint.
      '**/*.d.ts.map',
      '**/*.js.map',
      // The eslint config itself doesn't need to lint itself.
      'eslint.config.mjs',
      // Forge config + vite configs are mostly Node scripts; defer for
      // a future tightening pass once the renderer + electron passes
      // are stable.
      'forge.config.ts',
      'vite.*.config.ts',
      'vitest.config.ts',
      // Plain-JS scripts and root-level JS aren't in any tsconfig and
      // would just produce parsing errors under typed linting. Skip
      // for the same "future tightening" reason.
      'main.js',
      'postcss.config.js',
      'scripts/**',
    ],
  },

  // Base layer: core JS recommended + typescript-eslint typed-strict.
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  // Tell typescript-eslint about both TS projects (renderer + main).
  // We use the explicit `project` array rather than `projectService: true`
  // because projectService's nearest-tsconfig.json discovery picks up
  // the root tsconfig.json (renderer-only) and rejects every electron
  // file, since there's no `electron/tsconfig.json`. Listing both
  // projects keeps electron files covered without needing to introduce
  // a redundant tsconfig file just to satisfy discovery.
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: [
          './tsconfig.json',
          './tsconfig.electron.json',
          './tsconfig.node.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // React + React Hooks — applied only to renderer files (src/**).
  // Electron main-process code doesn't render React so these are noise
  // there. We use the flat-config presets shipped by each plugin.
  {
    files: ['src/**/*.{ts,tsx,js,jsx}'],
    ...reactPlugin.configs.flat.recommended,
    languageOptions: {
      ...reactPlugin.configs.flat.recommended.languageOptions,
      globals: {
        ...globals.browser,
      },
    },
    settings: {
      react: { version: 'detect' },
    },
  },
  {
    files: ['src/**/*.{ts,tsx,js,jsx}'],
    ...reactPlugin.configs.flat['jsx-runtime'],
  },
  {
    files: ['src/**/*.{ts,tsx,js,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Recommended set first, then per-rule policy. The v7 plugin
      // ships several new rules we'll adopt incrementally — keep
      // `exhaustive-deps` (the original Tier S ask) as error and the
      // rest as warn so they're visible without blocking the gate.
      ...reactHooks.configs.recommended.rules,
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/error-boundaries': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/purity': 'warn',
    },
  },

  // Node globals for main process + tests.
  {
    files: ['electron/**/*.{ts,js}', '**/*.test.{ts,tsx}', '**/*.config.{ts,js,mjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Project-wide rule policy. This is the SECOND-most-important block
  // in the config (after the base layer) — it tunes strict-type-checked
  // down to the rules that actually catch bugs in this codebase.
  {
    rules: {
      // ─── Keep: explicit additions for the highest-signal rules ──
      // switch-exhaustiveness-check is NOT in strictTypeChecked but is
      // exactly the rule that would have caught the lost-task_updated
      // payload bug at write time. Adding it explicitly.
      '@typescript-eslint/switch-exhaustiveness-check': ['error', {
        considerDefaultExhaustiveForUnions: true,
      }],

      // Honor the `_`-prefix convention for intentionally-unused
      // variables, parameters, and destructured values. tsconfig already
      // sets noUnusedLocals/noUnusedParameters with this convention; the
      // eslint rule needs explicit configuration to match.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],

      // ─── Off: stylistic noise ──
      // `${val}` where val isn't a string. JS coerces; the cases where
      // this matters are subtle and infrequent. ~140 sites in this codebase.
      '@typescript-eslint/restrict-template-expressions': 'off',
      // `||` vs `??`. The semantics differ for falsy-but-not-nullish
      // values (0, '', false). Existing code is intentional; flipping
      // them en masse would change behavior. ~120 sites.
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      // Empty `() => {}` callbacks are routine in tests (mock impls)
      // and React (no-op handlers). ~40 sites.
      '@typescript-eslint/no-empty-function': 'off',
      // `Number()`/`String()` paranoia — harmless. ~10 sites.
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
      // Catches `if (foo?.bar)` where `foo` is provably defined. Mostly
      // fires on defensive-coding patterns the original author wanted.
      // ~200 sites — too noisy as an error. Off rather than warn so it
      // stops appearing in the lint output entirely.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // `Promise<void>` in handlers / callbacks is legitimate.
      '@typescript-eslint/no-invalid-void-type': 'off',
      // `() => doThing()` is fine when doThing returns void. The
      // post-auto-fix residual is in places where the brace style
      // would harm readability.
      '@typescript-eslint/no-confusing-void-expression': 'off',
      // Common React pattern false positive (passing class methods as
      // event handlers).
      '@typescript-eslint/unbound-method': 'off',

      // ─── Warn (not error) for the `any`-cascade family ──
      // These all fire because of explicit `any` at the source. Gating
      // them as errors makes lint unrunnable until 173 explicit `any`
      // casts are eliminated — which is a large refactor of its own.
      // Keeping as warn so they stay visible in IDEs and counts but
      // don't fail the gate.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',

      // ─── Off: rules whose intent doesn't match this codebase ──
      // We use TypeScript, not PropTypes, for prop validation.
      'react/prop-types': 'off',
      // ' and < etc. in JSX text are fine; the codebase already uses
      // them for prose.
      'react/no-unescaped-entities': 'off',
      // Common false positive on inline / forwardRef components.
      'react/display-name': 'off',
      // The `use()` hook rule is aspirational for React 19+; we're on 18.
      'react/use': 'off',

      // (react-hooks rule policy lives in the renderer-only block above
      // because plugin registration must share the block with rule overrides
      // in flat config.)
    },
  },

  // Test-file relaxations. Vitest tests build deliberately-malformed
  // fixtures via `as unknown as ClaudeStreamMessage` etc.; the strict
  // rules would force us to author proper type narrowings on every
  // fixture, which is more friction than value.
  {
    files: ['**/*.test.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
