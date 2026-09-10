import { describe, it, expect } from 'vitest'
import {
  shouldIdleBank,
  IDLE_BANK_DELAY_MS,
  type IdleBankFacts,
} from './idle-watchdog.js'

/** A session that is idle, large, warm, unbanked and still listening. */
const eligible: IdleBankFacts = {
  msSinceLastTurn: IDLE_BANK_DELAY_MS + 1_000,
  peakContext: 120_000,
  alreadyBanked: false,
  growthSinceBank: 0,
  rotationEnabled: true,
  reBankGrowth: 100_000,
  socketExists: true,
}

describe('shouldIdleBank', () => {
  it('banks a large, idle, warm session that is still listening', () => {
    expect(shouldIdleBank(eligible)).toEqual({ act: 'bank' })
  })

  it('does nothing when a newer turn has landed since the timer was armed', () => {
    // The timer wakes on a clock; the transcript is the authority on whether
    // the session is actually idle.
    const verdict = shouldIdleBank({ ...eligible, msSinceLastTurn: 60_000 })
    expect(verdict.act).toBe('nothing')
  })

  it('does nothing when the transcript cannot be read', () => {
    expect(shouldIdleBank({ ...eligible, msSinceLastTurn: null }).act).toBe('nothing')
  })

  it('does nothing below the resume break-even', () => {
    // Below it the handoff's own entry cost eats the whole saving.
    expect(shouldIdleBank({ ...eligible, peakContext: 64_999 }).act).toBe('nothing')
  })

  it('banks exactly at the resume break-even', () => {
    expect(shouldIdleBank({ ...eligible, peakContext: 65_000 })).toEqual({ act: 'bank' })
  })

  it('does nothing when rotation is switched off', () => {
    expect(shouldIdleBank({ ...eligible, rotationEnabled: false }).act).toBe('nothing')
  })

  it('does nothing when the session has already banked and has not grown', () => {
    expect(
      shouldIdleBank({ ...eligible, alreadyBanked: true, growthSinceBank: 40_000 }).act
    ).toBe('nothing')
  })

  it('banks again once the session has grown past the re-bank step', () => {
    expect(
      shouldIdleBank({ ...eligible, alreadyBanked: true, growthSinceBank: 100_000 })
    ).toEqual({ act: 'bank' })
  })

  it('notifies rather than banks once the cache has gone cold', () => {
    // Banking after expiry costs full price, and the saving it existed for
    // has already been lost.
    expect(
      shouldIdleBank({ ...eligible, msSinceLastTurn: 61 * 60 * 1000 })
    ).toEqual({ act: 'notify', reason: 'cache-cold' })
  })

  it('notifies when the session has exited and its socket has gone', () => {
    expect(shouldIdleBank({ ...eligible, socketExists: false })).toEqual({
      act: 'notify',
      reason: 'session-gone',
    })
  })

  it('says nothing about a small session whose socket has gone', () => {
    // Nothing to say: it was never worth banking.
    expect(
      shouldIdleBank({ ...eligible, socketExists: false, peakContext: 10_000 }).act
    ).toBe('nothing')
  })
})

import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, vi } from 'vitest'

async function importFresh(tempDir: string) {
  vi.resetModules()
  vi.doMock('node:os', () => ({ homedir: () => tempDir }))
  return await import('./idle-watchdog.js')
}

describe('the timer file', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-timer-'))
  })
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    vi.doUnmock('node:os')
  })

  const file = (over: Record<string, unknown> = {}) => ({
    sessionId: 'sess-1',
    timerPid: process.pid,
    claudePid: process.pid,
    socketPath: '/tmp/cc-socks/1.sock',
    token: 'secret-token',
    cwd: '/home/user/project-a',
    transcriptPath: '/home/user/.claude/projects/p/sess-1.jsonl',
    armedAt: 1_000,
    firesAt: 2_000,
    ...over,
  })

  it('round-trips what the timer needs to act', async () => {
    const w = await importFresh(tempDir)
    w.writeTimerFile(file() as never)
    expect(w.readTimerFile('sess-1')).toEqual(file())
  })

  it('is readable only by its owner, because it carries a live token', async () => {
    const w = await importFresh(tempDir)
    w.writeTimerFile(file() as never)
    const mode = statSync(w.timerFilePath('sess-1')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('returns null for a session with no timer, and for a corrupt file', async () => {
    const w = await importFresh(tempDir)
    expect(w.readTimerFile('nobody')).toBeNull()
    mkdirSync(w.TIMERS_DIR, { recursive: true })
    writeFileSync(w.timerFilePath('broken'), '{ not json')
    expect(w.readTimerFile('broken')).toBeNull()
  })

  it('refuses a session id that is not a plain file name', async () => {
    const w = await importFresh(tempDir)
    expect(w.timerFilePath('../../escape')).toBeNull()
    expect(w.readTimerFile('../../escape')).toBeNull()
  })

  it('sweeps a timer whose process is dead', async () => {
    const w = await importFresh(tempDir)
    // PID 2^22 is above every pid_max in use and owns nothing.
    w.writeTimerFile(file({ sessionId: 'dead', timerPid: 4_194_304 }) as never)
    w.sweepTimerFiles()
    expect(existsSync(w.timerFilePath('dead')!)).toBe(false)
  })

  it('sweeps a timer whose session has exited, socket and all', async () => {
    const w = await importFresh(tempDir)
    w.writeTimerFile(file({ sessionId: 'gone', socketPath: join(tempDir, 'no.sock') }) as never)
    w.sweepTimerFiles()
    expect(existsSync(w.timerFilePath('gone')!)).toBe(false)
  })

  it('leaves a live timer alone', async () => {
    const w = await importFresh(tempDir)
    const sock = join(tempDir, 'live.sock')
    writeFileSync(sock, '')
    w.writeTimerFile(file({ sessionId: 'live', socketPath: sock }) as never)
    w.sweepTimerFiles()
    expect(existsSync(w.timerFilePath('live')!)).toBe(true)
  })

  it('sweeps a dead file by name, not by its recorded sessionId', async () => {
    // A timer file whose sessionId field names a different, live session.
    // The sweep must delete the dead file by name, not route through deleteTimerFile,
    // which would delete the wrong file.
    const w = await importFresh(tempDir)
    const liveSocket = join(tempDir, 'live.sock')
    writeFileSync(liveSocket, '')
    
    // Write a live timer for 'session-a' with a live process
    w.writeTimerFile(file({ sessionId: 'session-a', timerPid: process.pid, socketPath: liveSocket }) as never)
    
    // Manually create a dead timer file with filename 'dead-file.json' but sessionId content pointing to 'session-a'
    const deadPath = w.timerFilePath('dead-file')!
    const corruptedContent = JSON.stringify({
      sessionId: 'session-a',  // points to the live session
      timerPid: 4_194_304,  // dead pid
      claudePid: process.pid,
      socketPath: liveSocket,
      token: 'secret-token',
      cwd: '/home/user/project-a',
      transcriptPath: '/home/user/.claude/projects/p/sess-1.jsonl',
      armedAt: 1_000,
      firesAt: 2_000,
    }, null, 2)
    writeFileSync(deadPath, corruptedContent, { mode: 0o600 })
    
    w.sweepTimerFiles()
    
    // The dead file should be deleted by its actual filename
    expect(existsSync(w.timerFilePath('dead-file')!)).toBe(false)
    // The live session's file should still exist, untouched
    expect(existsSync(w.timerFilePath('session-a')!)).toBe(true)
  })
})
