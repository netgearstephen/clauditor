import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Runs before any test module, so modules that resolve paths from
    // homedir() at import time never touch the real home directory.
    setupFiles: ['./vitest.setup.ts'],
    globalSetup: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/tui/**'],
    },
  },
})
