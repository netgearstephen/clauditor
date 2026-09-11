import { existsSync } from 'node:fs'
import { readConfig } from '../config.js'
import { logActivity } from '../features/activity-log.js'
import {
  bankInstruction,
  handoffStamp,
  markUnattendedBank,
  msSinceLastTurn,
  peakContextTokens,
  readSessionBank,
  readTurns,
  recordBankRequest,
} from '../features/journal.js'
import {
  deleteTimerFile,
  readTimerFile,
  sendToInbox,
  shouldIdleBank,
  type IdleBankFacts,
  type IdleTimerFile,
} from '../features/idle-watchdog.js'
import { isHookEntry } from './shared.js'

/** How often the poller looks at its own file. A stat a minute, no more. */
const POLL_INTERVAL_MS = 60_000

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
    socketExists: existsSync(file.socketPath),
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
  if (!existsSync(file.socketPath)) {
    deleteTimerFile(sessionId)
    return 'nothing'
  }
  if (now < file.firesAt) return 'waiting'

  const facts = gatherIdleFacts(file, now)
  const verdict = shouldIdleBank(facts)
  const session = sessionId.slice(0, 8)

  if (verdict.act === 'bank') {
    // Written down before the message goes out, exactly as the Stop hook does
    // it: an unanswered request that was never recorded fires again at every
    // stop for the rest of the session.
    recordBankRequest(file.cwd, now, facts.peakContext, sessionId)
    // The woken session must not come back to a guard it never armed.
    markUnattendedBank(file.cwd, sessionId)
    const sent = await sendToInbox(
      file.socketPath,
      file.token,
      bankInstruction(facts.peakContext, {
        stamp: handoffStamp(),
        // The session's OWN bank. Never state.promotedPath: that told a
        // session which had never banked to overwrite another session's
        // document, and destroyed a real handoff on 2026-09-10.
        rewritePath: readSessionBank(sessionId)?.handoffPath ?? '',
      })
    )
    await logActivity({
      type: 'context_warning',
      session,
      message: sent
        ? `idle bank requested at ${facts.peakContext} peak context`
        : `idle bank could not be delivered at ${facts.peakContext} peak context`,
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
async function main(): Promise<void> {
  const sessionId = process.argv[2]
  if (!sessionId) return
  for (;;) {
    const outcome = await runIdleTimerOnce(sessionId)
    if (outcome !== 'waiting') return
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
}

if (isHookEntry('idle-timer')) {
  main().catch(() => process.exit(0))
}
