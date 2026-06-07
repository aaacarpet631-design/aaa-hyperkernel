/*
 * ESLint flat config for AAA HyperKernel.
 *
 * The codebase is a no-build PWA: browser-global IIFE modules under js/ (each
 * attaches AAA_* singletons to window), CommonJS cloud functions under
 * functions/, ESM serverless functions under netlify/functions/, and a custom
 * Node test runner under test/. Rules are tuned conservatively for that reality
 * — `no-undef` is off because cross-file browser globals can't be statically
 * resolved, and the intentional `catch (_) {}` pattern is allowed — while the
 * genuine bug-catchers (dupe keys, unreachable code, bad typeof, …) stay errors.
 */
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      '.netlify/**',
      'package-lock.json',
      '**/*.ts' // Deno edge functions (supabase/functions) — not lintable as Node JS here
    ]
  },

  js.configs.recommended,

  // Project-wide rule tuning for a legacy browser-global codebase.
  {
    rules: {
      'no-undef': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-cond-assign': ['error', 'except-parens'],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-prototype-builtins': 'off',
      'no-control-regex': 'off',
      // Surfaced (not errored) for a later cleanup phase: dead-store defensive
      // patterns (`let x = []; try { x = … } catch { x = [] }`) and a couple of
      // async Promise executors. Real smells, but rewriting them touches
      // behaviour-sensitive code, so Phase 1 only flags them.
      'no-useless-assignment': 'warn',
      'no-async-promise-executor': 'warn'
    }
  },

  // Browser PWA modules (IIFE singletons) + the service worker.
  {
    files: ['js/**/*.js', 'sw.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.serviceworker }
    }
  },

  // CommonJS cloud functions (require / module.exports).
  {
    files: ['functions/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node }
    }
  },

  // ESM serverless functions.
  {
    files: ['netlify/functions/**/*.mjs', '**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser }
    }
  },

  // Node test runner + suites (CommonJS) and the ESM smoke test.
  {
    files: ['test/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } }
  },
  {
    files: ['test/**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } }
  },

  // Build/dev scripts (ESM, Node).
  {
    files: ['scripts/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } }
  }
];
