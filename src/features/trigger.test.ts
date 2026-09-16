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
})
