import { writeFileSync, readFileSync, unlinkSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { connect } from 'node:net'
import { CACHE_TTL_MS } from './journal.js'
import { RESUME_BREAK_EVEN } from './resume-advisory.js'

/**
 * How long a session must sit idle before its handoff is banked unasked.
 *
 * Fifty-five minutes, against a one-hour cache TTL. The woken turn has to
 * start, read and write before the cache expires, and five minutes is the
 * margin for that. Firing at sixty would reliably wake a session into a cold
 * cache, which is the one case where banking is not worth doing.
 */
export const IDLE_BANK_DELAY_MS = 55 * 60 * 1000

/** Everything the verdict depends on, all of it re-read at fire time. */
export interface IdleBankFacts {
  /** Age of the last turn in the transcript; null when it cannot be read. */
  msSinceLastTurn: number | null
  /** Peak context of the session, from peakContextTokens. */
  peakContext: number
  /** Has this session already paid for a bank, in any directory? */
  alreadyBanked: boolean
  /** Peak growth since that bank, 0 when it has not banked. */
  growthSinceBank: number
  /** config.rotation.enabled. */
  rotationEnabled: boolean
  /** config.rotation.reBankGrowth. */
  reBankGrowth: number
  /** Is the session's inbox socket still there? */
  socketExists: boolean
}

export type IdleBankVerdict =
  | { act: 'bank' }
  | { act: 'notify'; reason: 'cache-cold' | 'session-gone' }
  | { act: 'nothing'; reason: string }

/**
 * Should this idle session be woken and asked to bank?
 *
 * Every rule lives here, and nothing here touches the filesystem or the
 * clock: the timer re-reads the facts and this decides on them. That split is
 * what makes the whole of the risk unit-testable, since the timer itself
 * cannot be exercised without a live session.
 */
export function shouldIdleBank(facts: IdleBankFacts): IdleBankVerdict {
  if (facts.msSinceLastTurn === null) {
    return { act: 'nothing', reason: 'transcript unreadable' }
  }
  // The timer wakes on a clock. The transcript decides whether the session is
  // idle, so a turn taken since arming cancels the firing outright.
  if (facts.msSinceLastTurn < IDLE_BANK_DELAY_MS) {
    return { act: 'nothing', reason: 'a turn landed since arming' }
  }
  if (!facts.rotationEnabled) return { act: 'nothing', reason: 'rotation disabled' }
  if (facts.peakContext < RESUME_BREAK_EVEN) {
    return { act: 'nothing', reason: 'below the resume break-even' }
  }
  if (facts.alreadyBanked && facts.growthSinceBank < facts.reBankGrowth) {
    return { act: 'nothing', reason: 'already banked and not materially grown' }
  }
  // Both remaining cases are worth saying out loud, and neither is worth
  // paying for: a cold bank costs full price, and a session that has exited
  // has nothing to wake.
  if (!facts.socketExists) return { act: 'notify', reason: 'session-gone' }
  if (facts.msSinceLastTurn >= CACHE_TTL_MS) {
    return { act: 'notify', reason: 'cache-cold' }
  }
  return { act: 'bank' }
}

/** One file per armed session. Never keyed by anything but the session id. */
export const TIMERS_DIR = resolve(homedir(), '.clauditor', 'timers')

/**
 * What the timer is told at arm time.
 *
 * The token is copied out of the Stop hook's environment because macOS does
 * not let one process read another's environment later, and the timer needs
 * it to authenticate to the inbox socket an hour after the hook has exited.
 * That is a live secret with a longer life than it has today, which is why
 * the file is 0600 and is deleted the moment it fires or is replaced.
 */
export interface IdleTimerFile {
  sessionId: string
  timerPid: number
  claudePid: number
  socketPath: string
  token: string
  cwd: string
  transcriptPath: string
  armedAt: number
  firesAt: number
}

/** Path for a session's timer file, or null if the id cannot be a filename. */
export function timerFilePath(sessionId: string): string | null {
  if (!sessionId || !/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) return null
  return resolve(TIMERS_DIR, `${sessionId}.json`)
}

export function writeTimerFile(file: IdleTimerFile): void {
  const path = timerFilePath(file.sessionId)
  if (!path) return
  try {
    mkdirSync(TIMERS_DIR, { recursive: true })
    writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 })
  } catch {}
}

export function readTimerFile(sessionId: string): IdleTimerFile | null {
  const path = timerFilePath(sessionId)
  if (!path) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as IdleTimerFile
  } catch {
    return null
  }
}

export function deleteTimerFile(sessionId: string): void {
  const path = timerFilePath(sessionId)
  if (!path) return
  try {
    unlinkSync(path)
  } catch {}
}

/** Is this pid still running? Signal 0 tests without delivering anything. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Remove timer files whose timer is dead or whose session has exited.
 *
 * The third cleanup mechanism, and the one that needs no signal to arrive.
 * SessionEnd covers the clean exit and the poller covers its own socket going
 * away, but neither survives a SIGKILL, so any Stop hook in any session sweeps
 * what is left. The cost is therefore bounded by open sessions, never by
 * transcripts on disk.
 */
export function sweepTimerFiles(): void {
  let names: string[]
  try {
    names = readdirSync(TIMERS_DIR).filter((n) => n.endsWith('.json'))
  } catch {
    return
  }
  for (const name of names) {
    const file = readTimerFile(name.replace(/\.json$/, ''))
    if (!file) {
      try {
        unlinkSync(resolve(TIMERS_DIR, name))
      } catch {}
      continue
    }
    if (!isProcessAlive(file.timerPid) || !existsSync(file.socketPath)) {
      try {
        unlinkSync(resolve(TIMERS_DIR, name))
      } catch {}
    }
  }
}

/**
 * Hand a message to a live session's inbox.
 *
 * The auth frame goes first, on its own line. Without it a session running
 * with permissions skipped cannot verify the sender as its own child, holds
 * the message for an approval nobody is present to give, and lets it expire
 * after five minutes. On macOS the process evidence counts only while the
 * sender is still running, so this resolves after the write has flushed and
 * the caller must stay alive until it does.
 */
export function sendToInbox(
  socketPath: string,
  token: string,
  message: string
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    const socket = connect(socketPath)
    socket.on('error', () => done(false))
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ type: 'auth', token })}\n`)
      socket.write(`${JSON.stringify({ type: 'message', message })}\n`, () => {
        socket.end()
        done(true)
      })
    })
  })
}
