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
