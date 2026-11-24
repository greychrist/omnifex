import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

import { noBareSpawn } from './eslint/no-bare-spawn.mjs';

export default defineConfig(
  {
    ignores: [
      'node_modules/**',
      'dist-web/**',
      'dist/**',
      // Plain JS outside every tsconfig: the type-aware rules cannot load for it.
      'web/public/sw.js',
      '.vite/**',
      'out/**',
      'coverage/**',
      'macos/**',
      '**/*.d.ts.map',
      '**/*.js.map',
      'eslint.config.mjs',
      // Plain-JS rule fragments; no tsconfig covers them.
      'eslint/**',
      'vite.*.config.ts',
      'vitest.config.ts',
      // Not in any tsconfig: typed linting would only produce parse errors.
      'postcss.config.js',
      'scripts/**',
    ],
  },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  // Explicit `project`, not `projectService`: discovery finds the renderer-only root tsconfig and rejects every daemon file.
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: [
          './tsconfig.json',
          './tsconfig.daemon.json',
          './tsconfig.node.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

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
      // exhaustive-deps gates; the newer v7 rules warn until adopted.
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

  {
    files: ['daemon/**/*.{ts,js}', '**/*.test.{ts,tsx}', '**/*.config.{ts,js,mjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  {
    rules: {
      // Not in strictTypeChecked; catches silent fall-throughs in discriminated-union switches.
      '@typescript-eslint/switch-exhaustiveness-check': ['error', {
        considerDefaultExhaustiveForUnions: true,
      }],

      // Match tsconfig's `_`-prefix convention for intentionally unused names.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],

      // JS coerces; the cases where it matters are rare.
      '@typescript-eslint/restrict-template-expressions': 'off',
      // `||` vs `??` differs for 0/''/false; existing uses are intentional.
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      // No-op callbacks are routine in tests and React handlers.
      '@typescript-eslint/no-empty-function': 'off',
      // `Number()`/`String()` is harmless.
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
      // Fires on intentional defensive checks; too noisy to surface at all.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // `Promise<void>` in handlers / callbacks is legitimate.
      '@typescript-eslint/no-invalid-void-type': 'off',
      // Braces would hurt readability where the expression is void.
      '@typescript-eslint/no-confusing-void-expression': 'off',
      // False positive on class methods passed as event handlers.
      '@typescript-eslint/unbound-method': 'off',
      // False positives: async interface conformance, settled-Promise test stubs, wire-contract IPC adapters.
      '@typescript-eslint/require-await': 'off',
      // `as HTMLElement` is the contextual type querySelector's generic needs; `!` leaves Element and tsc fails.
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',

      // Cascades from explicit `any`: visible as warnings, not gating.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',

      // We use TypeScript, not PropTypes, for prop validation.
      'react/prop-types': 'off',
      // Apostrophes and `<` in JSX prose are fine.
      'react/no-unescaped-entities': 'off',
      // Common false positive on inline / forwardRef components.
      'react/display-name': 'off',
      'react/use': 'off',

      // react-hooks rules live in the renderer block: flat config needs a plugin and its overrides in one block.
    },
  },

  // Daemon: never spawn a bare command name (a PATH probe per miss). Tests' spawns never run in the app.
  {
    files: ['daemon/**/*.ts'],
    ignores: ['daemon/**/__tests__/**'],
    rules: {
      'no-restricted-syntax': ['error', ...noBareSpawn],
    },
  },

  // Tests build deliberately malformed fixtures.
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
