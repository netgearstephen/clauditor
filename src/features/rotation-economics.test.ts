import { describe, it, expect } from 'vitest'
import { isRotationCostEffective, rotationBreakEvenRequests } from './rotation-economics.js'
import { HANDOFF_ENTRY_TOKENS } from './resume-advisory.js'

describe('rotationBreakEvenRequests', () => {
  it('shortens as the context grows', () => {
    const small = rotationBreakEvenRequests(100_000, 'claude-opus-5')!
    const large = rotationBreakEvenRequests(300_000, 'claude-opus-5')!
    expect(large).toBeLessThan(small)
  })

  it('prices opus 5 at 150k at about 13 requests', () => {
    const n = rotationBreakEvenRequests(150_000, 'claude-opus-5')!
    expect(n).toBeGreaterThan(12)
    expect(n).toBeLessThan(14)
  })

  it('is slower to repay where cache reads are cheaper', () => {
    const opus = rotationBreakEvenRequests(150_000, 'claude-opus-5')!
    const fable = rotationBreakEvenRequests(150_000, 'claude-fable-5-1')!
    expect(fable).toBeGreaterThan(opus)
  })

  it('never repays a context no bigger than a fresh session', () => {
    expect(rotationBreakEvenRequests(HANDOFF_ENTRY_TOKENS, 'claude-opus-5')).toBeNull()
  })

  it('charges a context past the long-context tier at the tier rate', () => {
    // Bank: (0.15M read x $0.01 + 0.003M out x $0.5) x 5 = $0.015. Entry, at
    // base rates: 50,362 1h writes x $0.2/M. Saving: 0.15M x $0.01 x 5 less
    // the new session's 50,362-token read at base.
    const bank = 0.015
    const entry = (HANDOFF_ENTRY_TOKENS / 1_000_000) * 0.2
    const saving = 0.0075 - (HANDOFF_ENTRY_TOKENS / 1_000_000) * 0.01
    expect(rotationBreakEvenRequests(150_000, 'claude-haiku-5-5')).toBeCloseTo(
      (bank + entry) / saving,
      10
    )
  })

  it('cannot price a missing or unbilled model', () => {
    expect(rotationBreakEvenRequests(150_000, null)).toBeNull()
    expect(rotationBreakEvenRequests(150_000, 'llama-local')).toBeNull()
  })
})

describe('isRotationCostEffective', () => {
  it('is always effective with a horizon of 0', () => {
    const v = isRotationCostEffective(70_000, 'claude-opus-5', 0)
    expect(v).toEqual({ effective: true, breakEvenRequests: null })
  })

  it('defers when break-even is beyond the horizon', () => {
    expect(isRotationCostEffective(150_000, 'claude-opus-5', 5).effective).toBe(false)
  })

  it('banks when break-even is within the horizon', () => {
    expect(isRotationCostEffective(150_000, 'claude-opus-5', 20).effective).toBe(true)
  })

  it('fails open when the model cannot be priced', () => {
    expect(isRotationCostEffective(150_000, null, 5).effective).toBe(true)
  })
})
