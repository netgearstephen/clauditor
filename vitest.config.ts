import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Several suites drive real subprocesses (the built hooks, python3, git)
    // whose own timeouts are 10-30s. A 5s test budget kills them mid-flight
    // under load, so the outer budget must exceed the inner ones.
    testTimeout: 30_000,
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
