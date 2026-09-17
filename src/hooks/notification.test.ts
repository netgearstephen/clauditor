import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const CWD = '/home/user/project-a'

describe('the Notification hook', () => {
  let tempDir: string
  let sockDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-notify-'))
    sockDir = join(tempDir, 'cc-socks')
    mkdirSync(sockDir, { recursive: true })
    // resolveClaudePid walks up from this process until it finds a socket
    // named for one of its ancestors. Naming it for the test process itself
    // is the shortest honest version of that.
    writeFileSync(join(sockDir, `${process.pid}.sock`), '')
    process.env.CLAUDITOR_SOCK_DIR = sockDir
  })

  afterEach(() => {
    delete process.env.CLAUDITOR_SOCK_DIR
    rmSync(tempDir, { recursive: true, force: true })
    vi.doUnmock('node:os')
    vi.resetModules()
  })

  async function importFresh() {
    vi.resetModules()
    vi.doMock('node:os', () => ({ homedir: () => tempDir, tmpdir: () => tempDir }))
    return {
      hook: await import('./notification.js'),
      w: await import('../features/idle-watchdog.js'),
    }
  }

  /** A transcript whose last real turn is `ageMs` old. */
  function transcript(ageMs: number): string {
    const path = join(tempDir, 'notify.jsonl')
    const ts = new Date(Date.now() - ageMs).toISOString()
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'user', cwd: CWD, timestamp: ts }),
        JSON.stringify({ type: 'assistant', timestamp: ts, message: { usage: {} } }),
      ].join('\n')
    )
    return path
  }

  /** An arming already in place, held by a poller this process can pass for. */
  function existingTimer(w: typeof import('../features/idle-watchdog.js'), path: string) {
    w.writeTimerFile({
      sessionId: 'notify-1',
      timerPid: process.pid,
      claudePid: process.pid,
      socketPath: join(sockDir, `${process.pid}.sock`),
      cwd: CWD,
      transcriptPath: path,
      armedAt: Date.now() - 20 * 60 * 1000,
      firesAt: Date.now() - 60_000,
    })
  }

  it('dates the wake from the last real turn, not from the notification', async () => {
    // The reason this hook exists. A session parks twenty minutes into its hour, and
    // arming 55 minutes from the notification would put the wake 15 minutes past the
    // cache it is meant to catch.
    const { hook, w } = await importFresh()
    const path = transcript(20 * 60 * 1000)
    existingTimer(w, path)

    await hook.handleNotificationHook({ session_id: 'notify-1', transcript_path: path })

    const file = w.readTimerFile('notify-1')
    expect(file).not.toBeNull()
    const remaining = file!.firesAt - Date.now()
    expect(remaining).toBeGreaterThan(34 * 60 * 1000)
    expect(remaining).toBeLessThanOrEqual(35 * 60 * 1000)
  })

  it('leaves a live poller running rather than respawning one per notification', async () => {
    // Notification can fire several times over one park. Each one rewrites
    // firesAt; none of them pays for a 42MB process.
    const { hook, w } = await importFresh()
    const path = transcript(60_000)
    existingTimer(w, path)

    await hook.handleNotificationHook({ session_id: 'notify-1', transcript_path: path })

    expect(w.readTimerFile('notify-1')!.timerPid).toBe(process.pid)
  })

  it('does nothing without a session id or a transcript to measure from', async () => {
    const { hook, w } = await importFresh()
    const path = transcript(60_000)
    existingTimer(w, path)
    const before = w.readTimerFile('notify-1')!.firesAt

    await hook.handleNotificationHook({ transcript_path: path })
    await hook.handleNotificationHook({ session_id: 'notify-1' })
    await hook.handleNotificationHook(null)

    expect(w.readTimerFile('notify-1')!.firesAt).toBe(before)
  })
})
