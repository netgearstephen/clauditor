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
