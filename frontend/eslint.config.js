// Advisory-only lint for the React Compiler rule family that oxlint does not yet
// implement natively (e.g. react-hooks/set-state-in-effect, immutability,
// preserve-manual-memoization). Run locally via `bun run lint:hooks`.
//
// This is NOT a CI gate. oxlint (`bun run lint`, see .oxlintrc.json) is the gate.
// Everything oxlint already covers (no-unused-vars, exhaustive-deps,
// rules-of-hooks, no-undef, max-lines, react-refresh) is turned OFF here so the
// two tools don't double-report. Drop this file once oxlint's JS-plugin support
// graduates from alpha and can run eslint-plugin-react-hooks directly.
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      // Owned by oxlint — disabled here to avoid duplicate diagnostics.
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/rules-of-hooks': 'off',
    },
  },
]);
