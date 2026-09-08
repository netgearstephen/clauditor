import { describe, it, expect } from 'vitest'
import { estimateCost, getPricingForModel } from './cost-tracker.js'
import { MODEL_PRICING } from '../types.js'
import type { TokenUsage } from '../types.js'

describe('estimateCost', () => {
  it('calculates cost for basic usage', () => {
    const usage: TokenUsage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
    const cost = estimateCost(usage, MODEL_PRICING['claude-sonnet-4-6'])
    // Sonnet pricing: $3/1M input + $15/1M output
    expect(cost.inputCost).toBeCloseTo(3.0)
    expect(cost.outputCost).toBeCloseTo(15.0)
    expect(cost.totalCost).toBeCloseTo(18.0)
  })

  it('calculates cache savings correctly', () => {
    const usage: TokenUsage = {
      input_tokens: 100_000,
      output_tokens: 50_000,
      cache_creation_input_tokens: 200_000,
      cache_read_input_tokens: 500_000,
    }
    const cost = estimateCost(usage)

    // Cache read is 0.10x input price — significant savings
    expect(cost.cacheReadCost).toBeLessThan(cost.inputCost)
    expect(cost.savedVsUncached).toBeGreaterThan(0)
  })

  it('returns zero savings when no cache is used', () => {
    const usage: TokenUsage = {
      input_tokens: 100_000,
      output_tokens: 50_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
    const cost = estimateCost(usage)
    expect(cost.savedVsUncached).toBe(0)
  })
})

describe('estimateCost cache TTL handling', () => {
  const opus5 = MODEL_PRICING['claude-opus-5']

  it('bills 1h and 5m writes at their separate rates', () => {
    const usage: TokenUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 2_000_000,
      cache_read_input_tokens: 0,
      cache_creation: {
        ephemeral_5m_input_tokens: 1_000_000,
        ephemeral_1h_input_tokens: 1_000_000,
      },
    }
    // 1M at $6.25 (1.25x) + 1M at $10.00 (2x)
    expect(estimateCost(usage, opus5).cacheCreationCost).toBeCloseTo(16.25)
  })

  it('assumes the 1h rate when no breakdown is present', () => {
    const usage: TokenUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 0,
    }
    // Claude Code writes at the 1h TTL. Assuming 5m understated this by 1.6x.
    expect(estimateCost(usage, opus5).cacheCreationCost).toBeCloseTo(10.0)
  })

  it('prices a realistic Opus 5 session correctly', () => {
    const usage: TokenUsage = {
      input_tokens: 6_946,
      output_tokens: 2_315_728,
      cache_creation_input_tokens: 11_437_505,
      cache_read_input_tokens: 467_211_772,
      cache_creation: { ephemeral_1h_input_tokens: 11_437_505 },
    }
    // Was reported as $217.81 under the Sonnet-4.6 fallback with 5m writes.
    expect(estimateCost(usage, opus5).totalCost).toBeCloseTo(405.9, 0)
  })
})

describe('getPricingForModel', () => {
  it('returns Sonnet pricing for sonnet model', () => {
    const pricing = getPricingForModel('claude-sonnet-4-6-20260301')
    expect(pricing.inputPerMillion).toBe(3.0)
  })

  it('prices Opus 4.6 at its actual rate, not a stale one', () => {
    const pricing = getPricingForModel('claude-opus-4-6-20260401')
    expect(pricing.inputPerMillion).toBe(5.0)
    expect(pricing.outputPerMillion).toBe(25.0)
  })

  it('prices Opus 5 rather than falling through to a cheaper model', () => {
    const pricing = getPricingForModel('claude-opus-5')
    expect(pricing.model).toBe('claude-opus-5')
    expect(pricing.inputPerMillion).toBe(5.0)
    expect(pricing.cacheReadPerMillion).toBe(0.5)
  })

  it('handles context-window suffixes such as claude-opus-5[1m]', () => {
    expect(getPricingForModel('claude-opus-5[1m]').model).toBe('claude-opus-5')
  })

  it('prefers the longest matching key when one key prefixes another', () => {
    // 'claude-fable-5' prefixes 'claude-fable-5-1'; first-match order would
    // price 5.1 as 5 and get the cache-read rate wrong by 4x.
    const pricing = getPricingForModel('claude-fable-5-1')
    expect(pricing.model).toBe('claude-fable-5-1')
    expect(pricing.cacheReadPerMillion).toBe(0.25)
  })

  it('prices Sonnet 5 separately from Sonnet 4.6', () => {
    expect(getPricingForModel('claude-sonnet-5').inputPerMillion).toBe(2.0)
  })

  it('falls back to the priciest known model for unknown IDs', () => {
    // Under-reporting is silent; over-reporting is visible and gets fixed.
    const pricing = getPricingForModel('some-unknown-model')
    expect(pricing.model).toBe('claude-fable-5-1')
  })
})
