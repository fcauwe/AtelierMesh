import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { globalSetup: ['./test/setup.ts'], environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 240000, hookTimeout: 120000 } })
