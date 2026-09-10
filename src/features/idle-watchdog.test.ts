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
