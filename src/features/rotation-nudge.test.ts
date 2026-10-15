import { describe, it, expect } from 'vitest'
import { shouldNudgeRotation } from './rotation-nudge.js'

const gate = 130_000
const growth = 50_000

describe('shouldNudgeRotation', () => {
  it('stays quiet below the gate', () => {
    expect(shouldNudgeRotation({ context: 129_999, gate, growth, nudgedAt: 0, bankedPeak: 0 })).toBe(false)
  })

  it('nudges the first time a turn carries the context past the gate', () => {
    expect(shouldNudgeRotation({ context: 131_000, gate, growth, nudgedAt: 0, bankedPeak: 0 })).toBe(true)
  })

  it('does not repeat until the session has grown materially since the last nudge', () => {
    expect(shouldNudgeRotation({ context: 170_000, gate, growth, nudgedAt: 131_000, bankedPeak: 0 })).toBe(false)
    expect(shouldNudgeRotation({ context: 181_000, gate, growth, nudgedAt: 131_000, bankedPeak: 0 })).toBe(true)
  })

  it('leaves a session that has already banked alone until it outgrows that bank', () => {
    expect(shouldNudgeRotation({ context: 160_000, gate, growth, nudgedAt: 0, bankedPeak: 135_000 })).toBe(false)
    expect(shouldNudgeRotation({ context: 186_000, gate, growth, nudgedAt: 0, bankedPeak: 135_000 })).toBe(true)
  })
})
