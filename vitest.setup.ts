import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Point HOME at a throwaway directory for the whole test run.
 *
 * Several modules resolve their storage path at import time, e.g.
 *   const CLAUDITOR_DIR = resolve(homedir(), '.clauditor')
 * so any test importing them without mocking node:os wrote to the developer's
 * real ~/.clauditor. That created fixture sessions under
 * ~/.clauditor/sessions/-home-user-project/ and overwrote last-session.md,
 * destroying real saved context and feeding fixture handoffs back into the
 * next Claude Code session start.
 *
 * os.homedir() reads $HOME on POSIX and $USERPROFILE on Windows, and this file
 * runs before any test module is imported, so setting both here isolates every
 * test whether or not it remembers to mock.
 */
const sandbox = mkdtempSync(join(tmpdir(), 'clauditor-test-home-'))
process.env.HOME = sandbox
process.env.USERPROFILE = sandbox

export function teardown() {
  rmSync(sandbox, { recursive: true, force: true })
}
