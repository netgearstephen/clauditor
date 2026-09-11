import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'

async function importFresh(tempDir: string) {
  vi.resetModules()
  vi.doMock('node:os', () => ({ homedir: () => tempDir }))
  return {
    timer: await import('./idle-timer.js'),
    w: await import('../features/idle-watchdog.js'),
  }
}

const CWD = '/home/user/project-a'

/** A transcript whose last turn is `ageMs` old and whose peak is `peak`. */
function transcript(dir: string, ageMs: number, peak: number): string {
  const path = join(dir, 'idle.jsonl')
  const ts = new Date(Date.now() - ageMs).toISOString()
  const recs = [
    { type: 'user', cwd: CWD, timestamp: ts },
    {
      type: 'assistant',
      timestamp: ts,
      message: {
        model: 'claude-opus-5',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: peak - 10,
        },
      },
    },
  ]
  writeFileSync(path, recs.map((r) => JSON.stringify(r)).join('\n'))
  return path
}

describe('the idle timer', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-idle-'))
  })
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    vi.doUnmock('node:os')
  })

  async function arm(over: Record<string, unknown> = {}) {
    const { timer, w } = await importFresh(tempDir)
    const sockPath = join(tempDir, 'inbox.sock')
    const received: string[] = []
    const server = createServer((c) => {
      c.on('data', (b) => received.push(...b.toString().split('\n').filter(Boolean)))
    })
    await new Promise<void>((r) => server.listen(sockPath, r))
    // The default transcript is only written when the caller has not already
    // supplied its own: writing it unconditionally here would run after an
    // override's transcript() call and clobber that file's content.
    const transcriptPath = (over.transcriptPath as string | undefined) ?? transcript(tempDir, 56 * 60 * 1000, 300_000)
    w.writeTimerFile({
      sessionId: 'idle-1',
      timerPid: process.pid,
      claudePid: process.pid,
      socketPath: sockPath,
      token: 'tok',
      cwd: CWD,
      transcriptPath,
      armedAt: Date.now() - 56 * 60 * 1000,
      firesAt: Date.now() - 60_000,
      ...over,
    } as never)
    return { timer, w, server, received }
  }

  it('waits while the fire time is still ahead', async () => {
    const { timer, server } = await arm({ firesAt: Date.now() + 600_000 })
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('waiting')
    server.close()
  })

  it('sends the bank request the Stop hook would have sent', async () => {
    const { timer, server, received } = await arm()
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('bank')
    await new Promise((r) => setTimeout(r, 50))
    server.close()
    expect(JSON.parse(received[0]).type).toBe('auth')
    expect(received[1]).toContain('cheapest moment')
  })

  it('logs a bank request handed over, claiming no more than the write proves', async () => {
    const { timer, server } = await arm()
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('bank')
    server.close()
    const activity = await import('../features/activity-log.js')
    const events = await activity.readActivity()
    expect(
      events.some(
        (e) =>
          e.message ===
          'idle bank handed to the session inbox, not yet acknowledged, at 300000 peak context'
      )
    ).toBe(true)
  })

  it('logs an undelivered bank request, so a refused connection is still auditable', async () => {
    // A plain file, not a socket, satisfies existsSync (so shouldIdleBank
    // still reaches 'bank') but refuses the connection sendToInbox attempts,
    // giving sent === false without ever touching the 'notify' path.
    const fakeSocket = join(tempDir, 'fake.sock')
    writeFileSync(fakeSocket, '')
    const { timer, server } = await arm({ socketPath: fakeSocket })
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('bank')
    server.close()
    const activity = await import('../features/activity-log.js')
    const events = await activity.readActivity()
    expect(
      events.some((e) => e.message === 'idle bank could not be delivered at 300000 peak context')
    ).toBe(true)
  })

  it('records the request, so an unanswered one does not re-fire at every stop', async () => {
    const { timer, w, server } = await arm()
    await timer.runIdleTimerOnce('idle-1')
    server.close()
    const j = await import('../features/journal.js')
    expect(j.readJournalState(CWD).bankRequestedSession).toBe('idle-1')
  })

  it('flags the bank as unattended, so the session is not left blocked', async () => {
    const { timer, server } = await arm()
    await timer.runIdleTimerOnce('idle-1')
    server.close()
    const j = await import('../features/journal.js')
    expect(j.takeUnattendedBank(CWD, 'idle-1')).toBe(true)
  })

  it('stamps the request on the session marker, so a woken re-bank can answer it', async () => {
    // The Stop hook writes recordBankRequest and markBankRequested together.
    // The second is what stands the wind-down guard aside for the Write the
    // bank instruction asks for, so a woken re-bank without it is told to
    // write a handoff and then refused the tool to write it with.
    const { timer, server } = await arm()
    const j = await import('../features/journal.js')
    j.markSessionBanked('idle-1', CWD, Date.now() - 60_000, {
      peakContext: 100_000,
      handoffPath: join(tempDir, 'handoff.md'),
    })
    expect(j.isBlockedAfterBank('idle-1', 'Write')).toBe(true)

    expect(await timer.runIdleTimerOnce('idle-1')).toBe('bank')
    server.close()
    expect(j.isBlockedAfterBank('idle-1', 'Write')).toBe(false)
  })

  it('writes its stamps where the session is now, not where it was armed', async () => {
    // The arm-time cwd is up to 55 minutes old, while the Stop hook that
    // handles the request reads the flag under its own current cwd. A session
    // that changed directory in between writes the flag in one place and
    // looks for it in another, and comes back to a guard it never armed.
    const { timer, server } = await arm({ cwd: '/home/user/where-it-was-armed' })
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('bank')
    server.close()

    const j = await import('../features/journal.js')
    expect(j.readJournalState(CWD).bankRequestedSession).toBe('idle-1')
    expect(j.takeUnattendedBank(CWD, 'idle-1')).toBe(true)
    expect(j.takeUnattendedBank('/home/user/where-it-was-armed', 'idle-1')).toBe(false)
  })

  it('says nothing to a socket path that now belongs to another session', async () => {
    // Sockets are keyed by pid. If the original claude exited and a new one
    // took that pid, the path still exists and the wake would be delivered to
    // a stranger's session.
    const { timer, w, server, received } = await arm({ socketInode: 999_999_999 })
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('nothing')
    await new Promise((r) => setTimeout(r, 50))
    server.close()
    expect(received).toEqual([])
    expect(existsSync(w.timerFilePath('idle-1')!)).toBe(false)
  })

  it('still acts on a timer file written before the inode was recorded', async () => {
    // Every file already on disk has no inode field. Reading absence as a
    // mismatch would strand all of them.
    const { timer, server } = await arm()
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('bank')
    server.close()
  })

  it('does not send anything to a session that has taken a turn since arming', async () => {
    const { timer, server, received } = await arm({
      transcriptPath: transcript(tempDir, 60_000, 300_000),
    })
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('nothing')
    server.close()
    expect(received).toEqual([])
  })

  it('deletes its own file once it has acted', async () => {
    const { timer, w, server } = await arm()
    await timer.runIdleTimerOnce('idle-1')
    server.close()
    expect(existsSync(w.timerFilePath('idle-1')!)).toBe(false)
  })

  it('logs a stood-down session, so an unattended silence is still auditable', async () => {
    const { timer, server } = await arm()
    const cfg = await import('../config.js')
    // Rotation disabled is the cheapest way to reach shouldIdleBank's
    // 'nothing' branch without needing a live bank or a particular growth.
    cfg.writeConfig({
      rotation: { enabled: false, minPeakContext: 200_000, reBankGrowth: 50_000, blockAfterBank: true },
      notifications: { desktop: true },
    })

    expect(await timer.runIdleTimerOnce('idle-1')).toBe('nothing')
    server.close()

    const activity = await import('../features/activity-log.js')
    const events = await activity.readActivity()
    expect(events.some((e) => e.message.includes('idle timer stood down'))).toBe(true)
  })

  it('logs a session it declines to wake into a cold cache, so the silence is auditable', async () => {
    const { CACHE_TTL_MS } = await import('../features/journal.js')
    const { timer, server } = await arm({
      transcriptPath: transcript(tempDir, CACHE_TTL_MS + 60_000, 300_000),
    })

    expect(await timer.runIdleTimerOnce('idle-1')).toBe('notify')
    server.close()

    const activity = await import('../features/activity-log.js')
    const events = await activity.readActivity()
    expect(events.some((e) => e.message.includes('cache-cold'))).toBe(true)
  })
})

describe('awaitOwnArming', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-idle-startup-'))
  })
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    vi.doUnmock('node:os')
  })

  // Closes the spawn/write race described in the plan: the parent writes the
  // timer file (naming this process's pid) only after spawning it, so the
  // poller's very first read can land before that write does. This is the
  // wait that stands in for that gap.
  it('returns true once the timer file comes to name this pid', async () => {
    const { timer, w } = await importFresh(tempDir)
    setTimeout(() => {
      w.writeTimerFile({
        sessionId: 'startup-1',
        timerPid: process.pid,
        claudePid: process.pid,
        socketPath: join(tempDir, 'inbox.sock'),
        token: 'tok',
        cwd: CWD,
        transcriptPath: transcript(tempDir, 0, 1_000),
        armedAt: Date.now(),
        firesAt: Date.now() + 1_000,
      } as never)
    }, 100)

    expect(await timer.awaitOwnArming('startup-1', 2_000)).toBe(true)
  })

  it('gives up once the grace has elapsed and the file still does not name it', async () => {
    const { timer } = await importFresh(tempDir)
    expect(await timer.awaitOwnArming('nobody-waiting', 200)).toBe(false)
  })

  it('does not wait past the grace once a later mismatch shows up', async () => {
    // Not this function's job once the poller is past startup: main's own
    // per-loop check (unchanged) is what exits on a later supersession. This
    // only pins that awaitOwnArming itself does not grant a second grace.
    const { timer, w } = await importFresh(tempDir)
    w.writeTimerFile({
      sessionId: 'startup-2',
      timerPid: process.pid + 1,
      claudePid: process.pid,
      socketPath: join(tempDir, 'inbox.sock'),
      token: 'tok',
      cwd: CWD,
      transcriptPath: transcript(tempDir, 0, 1_000),
      armedAt: Date.now(),
      firesAt: Date.now() + 1_000,
    } as never)
    const start = Date.now()
    expect(await timer.awaitOwnArming('startup-2', 300)).toBe(false)
    expect(Date.now() - start).toBeGreaterThanOrEqual(300)
  })
})
