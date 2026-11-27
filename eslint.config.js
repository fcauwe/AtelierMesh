import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// The headless core must stay portable: no React, three.js, zustand or Node-only imports in its source.
const portable = {
  files: ['packages/core/src/**/*.ts'],
  ignores: ['packages/core/src/testing/**'],
  rules: {
    'no-restricted-imports': ['error', { patterns: [
      { group: ['react', 'react-dom', 'react/*', 'three', 'three/*', 'zustand', 'zustand/*'], message: 'core is headless: no UI or rendering libraries' },
      { group: ['node:*'], message: 'core runs in browsers and workers: no Node-only imports' },
    ] }],
  },
}

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'spikes/**', 'packages/loader/bin/**', 'packages/loader/src/bootstrap.generated.ts', 'build/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-explicit-any': 'error', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] } },
  portable,
)
