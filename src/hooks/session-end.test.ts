import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import type { IdleTimerFile } from '../features/idle-watchdog.js'

async function importFresh(tempDir: string) {
  vi.resetModules()
  vi.doMock('node:os', () => ({ homedir: () => tempDir }))
  return {
    hook: await import('./session-end.js'),
    w: await import('../features/idle-watchdog.js'),
  }
}

function file(over: Partial<IdleTimerFile> = {}): IdleTimerFile {
  return {
    sessionId: 'closing',
    timerPid: 0,
    claudePid: process.pid,
    socketPath: '/tmp/clauditor-session-end-test-does-not-exist.sock',
    token: 'tok',
    cwd: '/home/user/project',
    transcriptPath: '/tmp/clauditor-session-end-test-does-not-exist.jsonl',
    armedAt: Date.now() - 60_000,
    firesAt: Date.now(),
    ...over,
  }
}

describe('the SessionEnd hook', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-session-end-'))
  })
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    vi.doUnmock('node:os')
  })

  it('kills the timer and removes its file when the session closes', async () => {
    const { hook, w } = await importFresh(tempDir)
    // A real child to kill, so the test proves the signal lands rather than
    // asserting on a mock. Its command line carries both halves of what the
    // identity check requires before it will signal a pid at all: the
    // poller's name and, as the real poller's argv does, the session id.
    const child = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 60000)', 'idle-timer-stub', 'closing'],
      { detached: true, stdio: 'ignore' }
    )
    child.unref()
    w.writeTimerFile(file({ sessionId: 'closing', timerPid: child.pid! }))

    await hook.handleSessionEndHook({ session_id: 'closing' } as never)

    expect(existsSync(w.timerFilePath('closing')!)).toBe(false)
    await new Promise((r) => setTimeout(r, 100))
    expect(w.isProcessAlive(child.pid!)).toBe(false)
  })

  // The one that matters: a timer file can outlive its poller by up to 55
  // minutes, and pids recycle. A live process whose command does not name
  // our poller must never be signalled just because a stale file names its
  // pid, even though the file itself is still cleaned up.
  it('leaves a live, non-matching process alone but still removes the file', async () => {
    const { hook, w } = await importFresh(tempDir)
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    w.writeTimerFile(file({ sessionId: 'closing-2', timerPid: child.pid! }))

    await hook.handleSessionEndHook({ session_id: 'closing-2' } as never)

    expect(existsSync(w.timerFilePath('closing-2')!)).toBe(false)
    expect(w.isProcessAlive(child.pid!)).toBe(true)
    child.kill()
  })

  it('leaves another session\'s poller alone, however stale its own file is', async () => {
    // Ten sessions are typically open on this machine, all of them running a
    // poller whose command line names idle-timer. A recycled pid that has
    // landed on one of those must not be signalled by this session's exit.
    const { hook, w } = await importFresh(tempDir)
    const child = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 60000)', 'idle-timer-stub', 'a-different-session'],
      { detached: true, stdio: 'ignore' }
    )
    child.unref()
    w.writeTimerFile(file({ sessionId: 'closing-3', timerPid: child.pid! }))

    await hook.handleSessionEndHook({ session_id: 'closing-3' } as never)

    expect(existsSync(w.timerFilePath('closing-3')!)).toBe(false)
    await new Promise((r) => setTimeout(r, 100))
    expect(w.isProcessAlive(child.pid!)).toBe(true)
    child.kill()
  })

  it('does nothing for a session that was never armed', async () => {
    const { hook } = await importFresh(tempDir)
    await expect(
      hook.handleSessionEndHook({ session_id: 'never' } as never)
    ).resolves.toBeUndefined()
  })

  it('does nothing when there is no session id', async () => {
    const { hook } = await importFresh(tempDir)
    await expect(hook.handleSessionEndHook(null)).resolves.toBeUndefined()
    await expect(hook.handleSessionEndHook({} as never)).resolves.toBeUndefined()
  })
})
