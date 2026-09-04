import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 5_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/cli.ts'],
      reporter: ['text', 'lcov'],
    },
  },
})
