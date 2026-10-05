import { afterEach } from 'vitest'

/**
 * Give the worker one turn of its event loop after every test.
 *
 * The subprocess suites block on execFileSync, and between synchronous tests
 * vitest only yields microtasks, so a worker never reads the main process's
 * replies to its RPC calls. Once a file ran past birpc's 60s timeout (the
 * stop-bank suite does), the expired timer fired before the waiting reply was
 * read and the run failed with `Timeout calling "onTaskUpdate"`, with every
 * test green. setImmediate runs after the poll phase, so the replies land.
 */
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)))
