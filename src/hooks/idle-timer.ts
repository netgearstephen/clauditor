import { readConfig } from '../config.js'
import { logActivity } from '../features/activity-log.js'
import {
  bankInstruction,
  cwdFromTranscript,
  handoffStamp,
  markBankRequested,
  markUnattendedBank,
  msSinceLastTurn,
  peakContextTokens,
  readSessionBank,
  readTurns,
  recordBankRequest,
} from '../features/journal.js'
import {
  deleteTimerFile,
  readInboxAuth,
  readTimerFile,
  sendToInbox,
  shouldIdleBank,
  socketStillOurs,
  type IdleBankFacts,
  type IdleTimerFile,
} from '../features/idle-watchdog.js'
import { isHookEntry } from './shared.js'

/** How often the poller looks at its own file. A stat a minute, no more. */
const POLL_INTERVAL_MS = 60_000

/** How long a freshly spawned poller waits to see its own pid land. */
const STARTUP_GRACE_MS = 2_000

/** How often it checks, while waiting on that startup grace. */
const STARTUP_POLL_MS = 50

/**
 * Wait for this process's own arming to land, once, at startup.
 *
 * The parent spawns this process before it knows this pid, so it writes the
 * timer file naming it only afterwards. A poller that reads first sees either
 * no file or the previous arming's pid and, without this, would exit at once:
 * the case that loses that race is a session whose last-ever Stop was the one
 * that raced, which is exactly the case the watchdog exists for.
 *
 * This grace applies only here, before the first successful
 * self-identification. Once that has happened, main's own per-loop read is
 * what governs: a later mismatch there (a respawn superseding this poller)
 * still exits immediately, with no second grace.
 */
export async function awaitOwnArming(
  sessionId: string,
  timeoutMs: number = STARTUP_GRACE_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const file = readTimerFile(sessionId)
    if (file?.timerPid === process.pid) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, STARTUP_POLL_MS))
  }
}

/**
 * Re-derive every fact from disk.
 *
 * Nothing believed at arm time is trusted: this process has been asleep for
 * the best part of an hour, and the session may have taken twenty turns,
 * banked, changed directory or exited since.
 */
export function gatherIdleFacts(file: IdleTimerFile, now: number = Date.now()): IdleBankFacts {
  const config = readConfig()
  const { turns } = readTurns(file.transcriptPath)
  const peakContext = peakContextTokens(turns)
  const bank = readSessionBank(file.sessionId)
  return {
    msSinceLastTurn: msSinceLastTurn(file.transcriptPath, now),
    peakContext,
    alreadyBanked: bank !== null,
    growthSinceBank: bank ? peakContext - bank.peakContext : 0,
    rotationEnabled: config.rotation.enabled,
    reBankGrowth: config.rotation.reBankGrowth,
    socketExists: socketStillOurs(file),
  }
}

/**
 * One pass: is it time, and if so what does the verdict say to do?
 *
 * Every outcome is logged, including the ones that do nothing, because a
 * message held for an approval nobody is there to give is invisible from
 * outside and the log is the only place the silence is auditable.
 */
export async function runIdleTimerOnce(
  sessionId: string,
  now: number = Date.now()
): Promise<'bank' | 'notify' | 'nothing' | 'waiting'> {
  const file = readTimerFile(sessionId)
  if (!file) return 'nothing'
  // Not merely "is something listening there": sockets are keyed by pid, and
  // if the session exited and a new claude took its pid, the wake would be
  // delivered to a stranger.
  if (!socketStillOurs(file)) {
    deleteTimerFile(sessionId)
    return 'nothing'
  }
  if (now < file.firesAt) return 'waiting'

  const facts = gatherIdleFacts(file, now)
  const verdict = shouldIdleBank(facts)
  const session = sessionId.slice(0, 8)

  if (verdict.act === 'bank') {
    // Where the session is now, not where it was when the timer was armed up
    // to 55 minutes ago: the Stop hook that handles the request reads these
    // stamps under its own current directory, and a session that has changed
    // directory since would look in a place nothing was written.
    const cwd = cwdFromTranscript(file.transcriptPath) ?? file.cwd
    // Both stamps, and before the message goes out, exactly as the Stop hook
    // does it. A request that was never recorded fires again at every stop
    // for the rest of the session, and the second stamp is what stands the
    // wind-down guard aside for the Write this instruction asks for.
    recordBankRequest(cwd, now, facts.peakContext, sessionId)
    markBankRequested(sessionId, now)
    // The woken session must not come back to a guard it never armed.
    markUnattendedBank(cwd, sessionId)
    // Read now, not at arm time: the peerToken is what a detached sender must
    // present, it lives in the session's key file rather than any hook's
    // environment, and a session that has exited since arming has taken it
    // with it, which is the honest signal that there is nothing left to wake.
    const auth = readInboxAuth(file.socketPath)
    const sent =
      auth !== null &&
      (await sendToInbox(
        file.socketPath,
        auth,
        bankInstruction(facts.peakContext, {
          stamp: handoffStamp(),
          // The session's OWN bank. Never state.promotedPath: that told a
          // session which had never banked to overwrite another session's
          // document, and destroyed a real handoff on 2026-09-10.
          rewritePath: readSessionBank(sessionId)?.handoffPath ?? '',
        })
      ))
    await logActivity({
      type: 'context_warning',
      session,
      // Sent, not received: the send resolves when the kernel takes the
      // bytes, not when the session acknowledges them. `requested` belongs to
      // what recordBankRequest wrote, and this line is the only visibility
      // into a message held for an approval nobody is present to give.
      message: sent
        ? `idle bank sent at ${facts.peakContext} peak context`
        : `idle bank could not be sent at ${facts.peakContext} peak context`,
    })
    deleteTimerFile(sessionId)
    return 'bank'
  }

  if (verdict.act === 'notify') {
    await logActivity({
      type: 'context_warning',
      session,
      message: `idle session not banked (${verdict.reason}) at ${facts.peakContext} peak context`,
    })
    deleteTimerFile(sessionId)
    return 'notify'
  }

  await logActivity({
    type: 'context_warning',
    session,
    message: `idle timer stood down: ${verdict.reason}`,
  })
  deleteTimerFile(sessionId)
  return 'nothing'
}

/** Poll until this session's timer has fired, been superseded or gone away. */
export async function main(): Promise<void> {
  const sessionId = process.argv[2]
  if (!sessionId) return
  if (!(await awaitOwnArming(sessionId))) return
  for (;;) {
    // Checked here, not inside runIdleTimerOnce: the tests call that
    // directly under their own pid, and it must still act. A poller left
    // running from an earlier arming otherwise keeps looping on whatever
    // file now sits at this path, and two such pollers can both read the
    // file and both send inside the same await sendToInbox window, turning
    // one arming into two bank requests.
    const file = readTimerFile(sessionId)
    if (!file || file.timerPid !== process.pid) return
    const outcome = await runIdleTimerOnce(sessionId)
    if (outcome !== 'waiting') return
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
}

if (isHookEntry('idle-timer')) {
  main().catch(() => process.exit(0))
}
