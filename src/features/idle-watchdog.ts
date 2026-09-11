import {
  writeFileSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
  existsSync,
  chmodSync,
  statSync,
} from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
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

/** Where Claude Code puts one inbox socket per live session process. */
export const SOCK_DIR = process.env.CLAUDITOR_SOCK_DIR ?? '/tmp/cc-socks'

/**
 * Find the `claude` process this hook is running under.
 *
 * Sockets are keyed by PID, never by session id, so this mapping can only be
 * made while the session is alive, which is why arming captures it rather
 * than the timer resolving it later. A hook process reaches its own claude in
 * three hops up the parent chain, verified live; the cap is generous against
 * that.
 */
export function resolveClaudePid(
  startPid: number = process.pid,
  sockDir: string = SOCK_DIR
): { pid: number; socketPath: string } | null {
  let pid = startPid
  for (let hop = 0; hop < 8 && pid > 1; hop++) {
    const socketPath = resolve(sockDir, `${pid}.sock`)
    if (existsSync(socketPath)) return { pid, socketPath }
    try {
      pid = Number(
        execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf-8' }).trim()
      )
    } catch {
      return null
    }
    if (!Number.isFinite(pid)) return null
  }
  return null
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
  /**
   * The socket's inode at arm time, when it is known.
   *
   * Sockets are keyed by pid, and this path is up to 55 minutes old by the
   * time the poller reads it: if the original `claude` exited and a new one
   * took that pid, the path exists but belongs to a stranger's session.
   * Optional, because every file written before this shipped lacks it, and
   * absence has to mean "no check available" rather than "mismatch".
   */
  socketInode?: number
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
    mkdirSync(TIMERS_DIR, { mode: 0o700, recursive: true })
    writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 })
    // Both modes applied again after the fact, because mkdirSync's and
    // writeFileSync's apply at creation only: anything that was already there
    // keeps whatever permissions it had, and the directory this feature
    // shipped with was created 0755. The file carries a live auth token for
    // the best part of an hour.
    chmodSync(TIMERS_DIR, 0o700)
    chmodSync(path, 0o600)
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

/**
 * Is this pid still running? Signal 0 tests without delivering anything.
 *
 * Zero is refused before it reaches the kernel: `process.kill(0, 0)` signals
 * the caller's own process group and succeeds, so a timer file carrying the
 * zero that a failed spawn writes would read as alive, never be respawned and
 * never be swept, leaving the session unwatched for ever. Negative pids name
 * process groups for the same reason.
 */
export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The inode of whatever is at this path, or undefined if nothing is. */
export function socketInode(socketPath: string): number | undefined {
  try {
    return statSync(socketPath).ino
  } catch {
    return undefined
  }
}

/**
 * Is the socket at the recorded path still the one that was recorded?
 *
 * A missing inode means the file predates the check, so liveness of the path
 * is all there is to go on: reading absence as a mismatch would strand every
 * timer already on disk.
 */
export function socketStillOurs(file: Pick<IdleTimerFile, 'socketPath' | 'socketInode'>): boolean {
  if (!existsSync(file.socketPath)) return false
  if (file.socketInode === undefined) return true
  return socketInode(file.socketPath) === file.socketInode
}

/**
 * Does this pid's command line name the poller for this session?
 *
 * A timer file can outlive the poller it names by up to 55 minutes, and pids
 * recycle in that time. `isProcessAlive` only answers "some process holds
 * this pid", so anything that signals a pid on that basis alone risks
 * SIGTERMing an unrelated process the OS has since handed the pid to.
 * SessionEnd is the caller that matters: it must confirm identity, not just
 * liveness, before it signals anything.
 *
 * The session id is required, not merely the poller's name: the poller takes
 * it as its argv, and matching the name alone makes every poller on the
 * machine look like this session's own. Ten sessions are typically open here,
 * so that is not a theoretical mismatch, and the one thing worse than failing
 * to stop your own timer is killing somebody else's. Same shape as
 * `resolveClaudePid`'s use of `ps` below, since inventing a second way to
 * read a process's command would be needless.
 */
export function isOurPoller(pid: number, sessionId: string): boolean {
  // An empty id would match every command line there is.
  if (!sessionId) return false
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf-8',
    })
    return command.includes('idle-timer') && command.includes(sessionId)
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
    // Deleted by name, never through deleteTimerFile: a file whose sessionId
    // field names a different session would take that session's timer with it.
    if (!file || !isProcessAlive(file.timerPid) || !socketStillOurs(file)) {
      try {
        unlinkSync(resolve(TIMERS_DIR, name))
      } catch {}
    }
  }
}

/**
 * How long sendToInbox waits for the write to flush before giving up.
 *
 * A live, listening session whose peer is wedged or backlogged never fires
 * the write's flush callback, and without a timeout that leaves the detached
 * poller awaiting it forever: nothing left to kill it, and sweepTimerFiles
 * cannot reap a timer file whose timerPid is that very hung process. Five
 * seconds is generous for a local Unix socket write and short enough that a
 * genuinely wedged peer is reported, not waited on.
 */
export const SEND_TIMEOUT_MS = 5_000

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
      socket.destroy()
      resolve(ok)
    }
    const socket = connect(socketPath)
    socket.setTimeout(SEND_TIMEOUT_MS, () => done(false))
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

/**
 * The poller's entry point, probed rather than assumed.
 *
 * Two layouts are live at once. `clauditor hook stop`, which is what
 * `install.ts` writes, runs the Stop hook inlined into `dist/cli.js`, so the
 * poller sits in a `hooks` subdirectory; the unbundled `dist/hooks/stop.js`
 * has it as a sibling. Assuming either one silently produced a spawn that
 * died on boot with `Cannot find module`, and a timer file naming a dead pid.
 */
export function resolvePollerEntry(here: string): string | null {
  const candidates = [resolve(here, 'hooks', 'idle-timer.js'), resolve(here, 'idle-timer.js')]
  return candidates.find(existsSync) ?? null
}

/**
 * Start a detached poller, and return its pid or 0.
 *
 * The `error` handler is not optional. An unhandled `error` event on a
 * `ChildProcess` throws, and it throws asynchronously, after the Stop hook has
 * returned and outside its promise chain, where `runHookSafely` cannot catch
 * it: a spawn that fails under resource pressure would take the hook down
 * before it wrote its decision. A zero pid is what the caller sees instead,
 * and the next Stop respawns.
 */
export function spawnPoller(
  entry: string,
  sessionId: string,
  execPath: string = process.execPath
): number {
  const child = spawn(execPath, [entry, sessionId], { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
  return child.pid ?? 0
}
