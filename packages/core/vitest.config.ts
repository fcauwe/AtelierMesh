import { defineConfig } from 'vitest/config'

// node environment on purpose: there is no DOM, and the tests prove the core does not need one
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/testing/**'], thresholds: { lines: 80 } },
  },
})
