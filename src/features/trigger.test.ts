import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resolveTrigger, resetTriggerWarnings, WINDOW_FRACTION } from './trigger.js'
import type { ClauditorUserConfig } from '../config.js'

/** A full config with the trigger fields under test overridden. */
function config(trigger: Partial<ClauditorUserConfig['rotation']['trigger']>): ClauditorUserConfig {
  return {
    rotation: {
      enabled: true,
      minPeakContext: 150_000,
      reBankGrowth: 50_000,
      blockAfterBank: true,
      trigger: { peakContext: 150_000, buffer: 0, minRequestsSinceBank: 20, perModel: {}, ...trigger },
    },
    pricing: { discount: 0, perModel: {} },
    notifications: { desktop: true },
  }
}

describe('resolveTrigger', () => {
  beforeEach(() => resetTriggerWarnings())

  it('uses the top-level settings when there is no override', () => {
    const t = resolveTrigger('claude-opus-5', config({}))
    expect(t.gate).toBe(150_000)
    expect(t.minRequestsSinceBank).toBe(20)
    expect(t.clampedTo).toBeNull()
  })

  it('fires the buffer early without moving the configured gate', () => {
    const t = resolveTrigger('claude-opus-5', config({ buffer: 10_000 }))
    expect(t.peakContext).toBe(150_000)
    expect(t.gate).toBe(140_000)
  })

  it('prefers a per-model override, field by field', () => {
    // Field by field, not object by object: an override naming only the
    // request floor must not drop the model back to a default peak.
    const t = resolveTrigger(
      'claude-haiku-4-5',
      config({ perModel: { 'claude-haiku-4-5': { minRequestsSinceBank: 5 } } })
    )
    expect(t.minRequestsSinceBank).toBe(5)
    expect(t.gate).toBe(150_000)
  })

  it('keys the override by the same longest-prefix rule as pricing', () => {
    const t = resolveTrigger(
      'claude-opus-5[1m]',
      config({ perModel: { 'claude-opus-5': { peakContext: 120_000 } } })
    )
    expect(t.gate).toBe(120_000)
  })

  it('clamps a gate that sits above the model window', () => {
    // 150k against Haiku's 200k window is fine; 250k could never be reached,
    // and an unreachable gate does not set banking late, it turns it off.
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    const t = resolveTrigger('claude-haiku-4-5', config({ peakContext: 250_000 }))
    expect(t.gate).toBe(200_000 * WINDOW_FRACTION)
    expect(t.clampedTo).toBe(200_000 * WINDOW_FRACTION)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('warns once per model, not once per turn', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    resolveTrigger('claude-haiku-4-5', config({ peakContext: 250_000 }))
    resolveTrigger('claude-haiku-4-5', config({ peakContext: 250_000 }))
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('does not clamp when the window is unknown', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    const t = resolveTrigger('claude-opus-4-6', config({ peakContext: 900_000 }))
    expect(t.gate).toBe(900_000)
    expect(t.clampedTo).toBeNull()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('falls back to the top level when the model is not known at all', () => {
    const t = resolveTrigger(null, config({ perModel: { 'claude-opus-5': { peakContext: 1 } } }))
    expect(t.gate).toBe(150_000)
  })

  it('floors a gate that a buffer larger than the peak would push negative', () => {
    // A negative gate is beaten by every session's first turn: the failure
    // mode the clamp exists to prevent, arrived at from the other direction.
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    const t = resolveTrigger('claude-opus-5', config({ peakContext: 150_000, buffer: 200_000 }))
    expect(t.gate).toBe(0)
    expect(t.clampedTo).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('falls back to a finite gate when a knob resolves to a non-numeric value', () => {
    // config.ts passes JSON straight through with no validation, so a
    // non-numeric buffer is reachable, not hypothetical.
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    const t = resolveTrigger('claude-opus-5', config({ buffer: Number.NaN }))
    expect(Number.isFinite(t.gate)).toBe(true)
    expect(t.gate).toBeGreaterThanOrEqual(0)
    expect(t.clampedTo).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('falls the request floor open to 0 when it resolves to a non-numeric value', () => {
    // Fails open, not closed: a floor nobody can satisfy would stop banking
    // altogether and say nothing, which is the failure this module exists to
    // prevent. The gate has this guard; the floor beside it must too.
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    const t = resolveTrigger('claude-opus-5', config({ minRequestsSinceBank: Number.NaN }))
    expect(t.minRequestsSinceBank).toBe(0)
    expect(t.gate).toBe(150_000)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('falls the request floor open to 0 when it is negative, and leaves a floor of 0 alone', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    expect(resolveTrigger('claude-opus-5', config({ minRequestsSinceBank: -5 })).minRequestsSinceBank).toBe(0)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()

    // 0 is a legitimate setting, meaning no floor, and must pass the guard
    // rather than trip it.
    const quiet = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    expect(resolveTrigger('claude-opus-5', config({ minRequestsSinceBank: 0 })).minRequestsSinceBank).toBe(0)
    expect(quiet).not.toHaveBeenCalled()
    quiet.mockRestore()
  })

  it('warns on a misconfigured gate even with no model to key the warning by', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    const t = resolveTrigger(null, config({ peakContext: 100_000, buffer: 200_000 }))
    expect(t.gate).toBe(0)
    expect(t.clampedTo).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
