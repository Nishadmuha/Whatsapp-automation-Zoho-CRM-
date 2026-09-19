'use strict';
const js = require('@eslint/js');
module.exports = [
  { ignores: ['node_modules/**', 'data/**', '.local-postgres/**', 'coverage/**', 'scratch/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024, sourceType: 'commonjs',
      globals: Object.fromEntries(['__dirname', '__filename', 'process', 'console', 'Buffer', 'URL', 'URLSearchParams', 'AbortSignal', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'structuredClone'].map((name) => [name, 'readonly'])),
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-control-regex': 'off',
    },
  },
  { files: ['src/admin/*.js'], languageOptions: { sourceType: 'script', globals: { document: 'readonly', window: 'readonly', alert: 'readonly', localStorage: 'readonly', confirm: 'readonly', requestAnimationFrame: 'readonly' } } },
];
