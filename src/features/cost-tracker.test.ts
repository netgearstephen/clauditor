import { describe, it, expect, afterEach } from 'vitest'
import {
  estimateCost,
  getPricingForModel,
  contextTokens,
  pricingKeyForModel,
  resetPricingCache,
} from './cost-tracker.js'
import { MODEL_PRICING } from '../types.js'
import type { TokenUsage } from '../types.js'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const CONFIG_DIR = resolve(homedir(), '.clauditor')
const CONFIG_FILE = resolve(CONFIG_DIR, 'config.json')

/**
 * Put a raw config on disk for the pricing lookups to read.
 *
 * Paired with resetPricingCache at every call site, because the scaled table
 * is memoised for the life of the process and a file written after the first
 * lookup would otherwise never be seen.
 */
function writeUserConfig(raw: unknown) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(raw))
}

afterEach(() => {
  rmSync(CONFIG_FILE, { force: true })
  resetPricingCache()
})

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

  it('bills the remainder at 1h when the breakdown is zeroed or partial', () => {
    // An aggregate that seeds {5m: 0, 1h: 0} and never fills it must not
    // price every write at zero.
    const zeroed: TokenUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 0,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 0,
      },
    }
    expect(estimateCost(zeroed, opus5).cacheCreationCost).toBeCloseTo(10.0)

    const partial: TokenUsage = {
      ...zeroed,
      cache_creation: { ephemeral_5m_input_tokens: 400_000 },
    }
    // 400k at $6.25 + 600k unattributed at $10.00
    expect(estimateCost(partial, opus5).cacheCreationCost).toBeCloseTo(8.5)
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

  it('falls back to the priciest known model for unknown claude- IDs', () => {
    // Under-reporting is silent; over-reporting is visible and gets fixed.
    const pricing = getPricingForModel('claude-unreleased-9')
    expect(pricing.model).toBe('claude-fable-5-1')
  })
})

describe('non-Anthropic models', () => {
  it('costs a local Ollama model at zero', () => {
    const pricing = getPricingForModel('qwen36-35b:latest')
    expect(pricing.inputPerMillion).toBe(0)
    expect(pricing.model).toBe('non-anthropic')
  })

  it("costs Claude Code's <synthetic> marker at zero", () => {
    expect(getPricingForModel('<synthetic>').inputPerMillion).toBe(0)
  })

  it('still warns and uses fallback pricing for unknown claude- models', () => {
    const pricing = getPricingForModel('claude-something-new')
    expect(pricing.model).toBe('claude-fable-5-1')
  })
})

describe('contextTokens', () => {
  const usage: TokenUsage = {
    input_tokens: 1_000,
    output_tokens: 500,
    cache_creation_input_tokens: 9_000,
    cache_read_input_tokens: 190_000,
  }

  it('sums the three input classes', () => {
    expect(contextTokens(usage)).toBe(200_000)
  })

  it('excludes output, unlike rawTurnTokens', () => {
    // The distinction is load-bearing. Context is what the model was billed to
    // carry in, so a cold rewrite is priced on it; output is not re-read.
    expect(contextTokens(usage)).not.toBe(200_500)
  })

  it('is zero for an unused turn', () => {
    expect(
      contextTokens({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      })
    ).toBe(0)
  })
})

describe('context windows', () => {
  it('carries the window for the models whose window is known', () => {
    expect(getPricingForModel('claude-opus-5').windowTokens).toBe(1_000_000)
    expect(getPricingForModel('claude-sonnet-5').windowTokens).toBe(1_000_000)
    expect(getPricingForModel('claude-fable-5-1').windowTokens).toBe(1_000_000)
    expect(getPricingForModel('claude-sonnet-4-6').windowTokens).toBe(1_000_000)
    expect(getPricingForModel('claude-haiku-4-5').windowTokens).toBe(200_000)
  })

  it('leaves the window unset rather than guessing it', () => {
    // An unset window means "do not clamp", which is the safe default. A
    // guessed one would silently move a gate the user configured.
    expect(getPricingForModel('claude-opus-4-6').windowTokens).toBeUndefined()
    expect(getPricingForModel('qwen36-35b:latest').windowTokens).toBeUndefined()
  })
})

describe('the enterprise discount', () => {
  it('is inert at zero, down to object identity', () => {
    // The proof that the whole feature is off by default. Identity rather
    // than deep equality on purpose: an equal-but-copied object would mean
    // the scaling path is running and merely landing on the same numbers.
    expect(getPricingForModel('claude-opus-5')).toBe(MODEL_PRICING['claude-opus-5'])
  })

  it('scales every rate class by the top-level discount', () => {
    writeUserConfig({ pricing: { discount: 0.04 } })
    resetPricingCache()
    const p = getPricingForModel('claude-opus-5')
    expect(p.inputPerMillion).toBeCloseTo(4.8, 10)
    expect(p.outputPerMillion).toBeCloseTo(24.0, 10)
    expect(p.cacheCreationPerMillion).toBeCloseTo(6.0, 10)
    expect(p.cacheCreation1hPerMillion).toBeCloseTo(9.6, 10)
    expect(p.cacheReadPerMillion).toBeCloseTo(0.48, 10)
  })

  it('keeps the model id and the window through the scaling', () => {
    writeUserConfig({ pricing: { discount: 0.04 } })
    resetPricingCache()
    const p = getPricingForModel('claude-opus-5[1m]')
    expect(p.model).toBe('claude-opus-5')
    expect(p.windowTokens).toBe(1_000_000)
  })

  it('prefers a per-model discount over the top-level one', () => {
    writeUserConfig({
      pricing: { discount: 0.1, perModel: { 'claude-opus-5': { discount: 0.04 } } },
    })
    resetPricingCache()
    expect(getPricingForModel('claude-opus-5').inputPerMillion).toBeCloseTo(4.8, 10)
    expect(getPricingForModel('claude-sonnet-5').inputPerMillion).toBeCloseTo(1.8, 10)
  })

  it('leaves the unbilled models alone', () => {
    writeUserConfig({ pricing: { discount: 0.5 } })
    resetPricingCache()
    // Half off nothing is still nothing, and routing it through the scaling
    // would put a copy where a shared sentinel used to be.
    expect(getPricingForModel('qwen36-35b:latest').inputPerMillion).toBe(0)
    expect(getPricingForModel('<synthetic>').inputPerMillion).toBe(0)
  })

  it('reaches estimateCost even when no pricing is passed', () => {
    // The undefined-pricing path used to read MODEL_PRICING directly, which
    // would have quoted list price for every unknown model.
    writeUserConfig({ pricing: { discount: 0.5 } })
    resetPricingCache()
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
    expect(estimateCost(usage).inputCost).toBeCloseTo(5.0, 10)
  })

  it('clamps a nonsensical discount rather than inverting a price', () => {
    writeUserConfig({ pricing: { discount: 2 } })
    resetPricingCache()
    expect(getPricingForModel('claude-opus-5').inputPerMillion).toBe(0)
    writeUserConfig({ pricing: { discount: -1 } })
    resetPricingCache()
    expect(getPricingForModel('claude-opus-5').inputPerMillion).toBe(5.0)
  })
})

describe('pricingKeyForModel', () => {
  it('returns the longest matching key, not the first', () => {
    expect(pricingKeyForModel('claude-fable-5-1')).toBe('claude-fable-5-1')
    expect(pricingKeyForModel('claude-opus-5[1m]')).toBe('claude-opus-5')
    expect(pricingKeyForModel('claude-sonnet-4-6-20260301')).toBe('claude-sonnet-4-6')
  })

  it('returns null for anything the table does not cover', () => {
    expect(pricingKeyForModel('qwen36-35b:latest')).toBeNull()
    expect(pricingKeyForModel('claude-unreleased-9')).toBeNull()
  })
})

describe('an empty config', () => {
  it('prices a real session identically to the hard-coded table', () => {
    // The whole feature's default state, asserted end to end rather than per
    // field: an absent config file must produce the numbers the tool produced
    // before any of this existed.
    writeUserConfig({})
    resetPricingCache()
    const usage = {
      input_tokens: 12_000,
      output_tokens: 3_400,
      cache_creation_input_tokens: 180_000,
      cache_read_input_tokens: 2_400_000,
    }
    const viaConfig = estimateCost(usage, getPricingForModel('claude-opus-5'))
    const viaTable = estimateCost(usage, MODEL_PRICING['claude-opus-5'])
    expect(viaConfig).toEqual(viaTable)
  })
})
