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
