import type { TokenUsage, PricingConfig, TurnMetrics } from '../types.js'
import { MODEL_PRICING, FALLBACK_PRICING_MODEL } from '../types.js'

export interface CostEstimate {
  inputCost: number
  outputCost: number
  cacheCreationCost: number
  cacheReadCost: number
  totalCost: number
  savedVsUncached: number
}

/**
 * Estimate the cost of a token usage record.
 */
export function estimateCost(
  usage: TokenUsage,
  pricing?: PricingConfig
): CostEstimate {
  const p = pricing ?? MODEL_PRICING[FALLBACK_PRICING_MODEL]

  const inputCost = (usage.input_tokens / 1_000_000) * p.inputPerMillion
  const outputCost = (usage.output_tokens / 1_000_000) * p.outputPerMillion
  const cacheCreationCost =
    (usage.cache_creation_input_tokens / 1_000_000) * p.cacheCreationPerMillion
  const cacheReadCost =
    (usage.cache_read_input_tokens / 1_000_000) * p.cacheReadPerMillion
  const totalCost = inputCost + outputCost + cacheCreationCost + cacheReadCost

  // What it would have cost if all cache tokens were regular input
  const uncachedInputCost =
    ((usage.input_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens) /
      1_000_000) *
    p.inputPerMillion
  const uncachedTotal = uncachedInputCost + outputCost
  const savedVsUncached = uncachedTotal - totalCost

  return {
    inputCost,
    outputCost,
    cacheCreationCost,
    cacheReadCost,
    totalCost,
    savedVsUncached: Math.max(0, savedVsUncached),
  }
}

/** Model IDs that matched nothing, so we warn once per ID rather than per turn. */
const warnedUnknownModels = new Set<string>()

/**
 * Detect model from assistant record and return appropriate pricing.
 *
 * Matches the LONGEST key that prefixes the model ID. A plain first-match loop
 * is wrong here because several keys prefix others ('claude-fable-5' prefixes
 * 'claude-fable-5-1'), which would silently price a model as its predecessor.
 * Handles suffixed IDs such as 'claude-opus-5[1m]' and dated snapshots.
 */
export function getPricingForModel(modelId: string): PricingConfig {
  let best: PricingConfig | null = null
  let bestLen = -1
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (modelId.startsWith(key) && key.length > bestLen) {
      best = pricing
      bestLen = key.length
    }
  }
  if (best) return best

  // Unknown model. Never fail silently: an unpriced model used to fall through
  // to mid-tier pricing, which understated real spend without any signal.
  if (!warnedUnknownModels.has(modelId)) {
    warnedUnknownModels.add(modelId)
    process.emitWarning(
      `clauditor: no pricing entry for model "${modelId}"; ` +
        `costs are estimated using ${FALLBACK_PRICING_MODEL} rates and may be too high.`
    )
  }
  return MODEL_PRICING[FALLBACK_PRICING_MODEL]
}

/**
 * Format a cost estimate for display.
 */
export function formatCost(cost: CostEstimate): string {
  return [
    `Input:         ${formatDollars(cost.inputCost)}`,
    `Output:        ${formatDollars(cost.outputCost)}`,
    `Cache create:  ${formatDollars(cost.cacheCreationCost)}`,
    `Cache read:    ${formatDollars(cost.cacheReadCost)}`,
    `Total:         ${formatDollars(cost.totalCost)}`,
    `Saved vs uncached: ${formatDollars(cost.savedVsUncached)}`,
  ].join('\n')
}

/**
 * Format usage numbers for display.
 */
export function formatUsage(usage: TokenUsage): string {
  return [
    `Input:         ${usage.input_tokens.toLocaleString()}`,
    `Output:        ${usage.output_tokens.toLocaleString()}`,
    `Cache reads:   ${usage.cache_read_input_tokens.toLocaleString()}`,
    `Cache writes:  ${usage.cache_creation_input_tokens.toLocaleString()}`,
  ].join('\n')
}

function formatDollars(amount: number): string {
  if (amount < 0.01) return `~$${amount.toFixed(4)}`
  return `~$${amount.toFixed(2)}`
}
