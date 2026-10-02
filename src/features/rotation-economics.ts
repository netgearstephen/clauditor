import type { TokenUsage } from '../types.js'
import { estimateCost, getPricingForModel } from './cost-tracker.js'
import { HANDOFF_ENTRY_TOKENS } from './resume-advisory.js'

/**
 * Whether rotating is cheaper than carrying on, priced from the same rates
 * the rest of the tool charges.
 *
 * This is a break-even in requests, not a waste factor. The retired waste
 * factor was a ratio of recent to opening cost that nothing could act on
 * honestly; this compares two dollar amounts under an explicit horizon.
 *
 * Pure: everything it needs is passed in.
 */

/** Output tokens a bank turn writes. The ~3k that makes a small session a bad bet. */
export const BANK_OUTPUT_TOKENS = 3_000

function cost(usage: Partial<TokenUsage>, model: string): number {
  return estimateCost(
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      ...usage,
    },
    getPricingForModel(model)
  ).totalCost
}

/**
 * Requests after which rotating from `peakContext` has repaid itself, or null
 * when it cannot be priced or never repays.
 *
 * Spend: one warm bank turn (re-read the context, write the handoff) plus the
 * new session's cold entry write. Saving: every later request re-reads
 * peakContext - HANDOFF_ENTRY_TOKENS fewer tokens.
 */
export function rotationBreakEvenRequests(
  peakContext: number,
  model: string | null
): number | null {
  if (!model || !Number.isFinite(peakContext)) return null
  const bank =
    cost({ cache_read_input_tokens: peakContext, output_tokens: BANK_OUTPUT_TOKENS }, model)
  const entry = cost({ cache_creation_input_tokens: HANDOFF_ENTRY_TOKENS }, model)
  const savingPerRequest = cost(
    { cache_read_input_tokens: peakContext - HANDOFF_ENTRY_TOKENS },
    model
  )
  // Zero rates (a local model) or a context no bigger than a fresh session's.
  if (!(savingPerRequest > 0)) return null
  return (bank + entry) / savingPerRequest
}

export interface RotationCostVerdict {
  effective: boolean
  breakEvenRequests: number | null
}

/**
 * Is rotating worth it within `horizonRequests`? A horizon of 0 disables the
 * gate, and anything that cannot be priced is let through: the cost gate may
 * defer a bank, never silence one.
 */
export function isRotationCostEffective(
  peakContext: number,
  model: string | null,
  horizonRequests: number
): RotationCostVerdict {
  if (horizonRequests <= 0) return { effective: true, breakEvenRequests: null }
  const breakEvenRequests = rotationBreakEvenRequests(peakContext, model)
  if (breakEvenRequests === null) return { effective: true, breakEvenRequests }
  return { effective: breakEvenRequests <= horizonRequests, breakEvenRequests }
}
