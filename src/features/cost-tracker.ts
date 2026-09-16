import type { TokenUsage, PricingConfig, TurnMetrics } from '../types.js'
import { MODEL_PRICING, FALLBACK_PRICING_MODEL, ZERO_PRICING } from '../types.js'
import { readConfig, type PricingUserConfig } from '../config.js'

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
  // getPricingForModel rather than the table, so a caller with no model in
  // hand still gets the configured discount rather than list price.
  const p = pricing ?? getPricingForModel(FALLBACK_PRICING_MODEL)

  const inputCost = (usage.input_tokens / 1_000_000) * p.inputPerMillion
  const outputCost = (usage.output_tokens / 1_000_000) * p.outputPerMillion
  // Cache writes are billed by TTL: 1.25x base for 5m, 2x for 1h.
  // The breakdown is a hint, never the total: an unpopulated one would price
  // every write at zero, so the remainder is billed at the 1h rate.
  const write5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const unattributed = Math.max(
    0,
    usage.cache_creation_input_tokens - write5m - write1h
  )
  const cacheCreationCost =
    (write5m / 1_000_000) * p.cacheCreationPerMillion +
    ((write1h + unattributed) / 1_000_000) * p.cacheCreation1hPerMillion
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
 * The discount config and the scaled tables, read once per process.
 *
 * getPricingForModel is called once per turn inside the transcript parse
 * loop in session-state, and readConfig reads and parses a file on every
 * call. Caching the scaled table as well as the config keeps the hot path at
 * a map lookup. A hook process lives for one event, so nothing has to
 * invalidate this; the dashboard and the watch/CLI paths are
 * long-running, though, so an edited discount stays invisible to them until
 * restart. Acceptable: a contracted rate changes about never, and re-reading
 * per turn there is exactly the cost this cache exists to avoid.
 * resetPricingCache exists for the tests.
 */
let pricingConfig: PricingUserConfig | null = null
let discounted: Map<string, PricingConfig> | null = null

export function resetPricingCache(): void {
  pricingConfig = null
  discounted = null
}

function pricingOverrides(): PricingUserConfig {
  if (!pricingConfig) pricingConfig = readConfig().pricing
  return pricingConfig
}

/**
 * Fraction off list for one model key: per-model, then top level, then none.
 *
 * Clamped to 0 to 1. A discount above 1 would invert the sign of every rate
 * and a negative one would quietly report more than the invoice, and neither
 * is worth crashing a hook over, so both are clamped rather than rejected.
 */
function discountFor(key: string): number {
  const config = pricingOverrides()
  const value = config.perModel[key]?.discount ?? config.discount
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(value, 1)
}

/**
 * List price scaled by the discount, or the list entry itself at zero.
 *
 * Returning the original object at zero is what makes "no discount
 * configured" provably identical to the behaviour before this existed,
 * rather than merely arithmetically equal to it.
 */
function applyDiscount(pricing: PricingConfig, discount: number): PricingConfig {
  if (discount === 0) return pricing
  const factor = 1 - discount
  return {
    ...pricing,
    inputPerMillion: pricing.inputPerMillion * factor,
    outputPerMillion: pricing.outputPerMillion * factor,
    cacheCreationPerMillion: pricing.cacheCreationPerMillion * factor,
    cacheCreation1hPerMillion: pricing.cacheCreation1hPerMillion * factor,
    cacheReadPerMillion: pricing.cacheReadPerMillion * factor,
  }
}

/** The list entry for a key, scaled and memoised. */
function pricingForKey(key: string): PricingConfig {
  if (!discounted) discounted = new Map()
  const hit = discounted.get(key)
  if (hit) return hit
  const scaled = applyDiscount(MODEL_PRICING[key], discountFor(key))
  discounted.set(key, scaled)
  return scaled
}

/**
 * The longest MODEL_PRICING key that prefixes this model ID, or null.
 *
 * Extracted from getPricingForModel so the banking trigger can key its
 * per-model overrides the same way. One model-key rule in the codebase, not
 * two: a plain first-match loop is wrong here because several keys prefix
 * others ('claude-fable-5' prefixes 'claude-fable-5-1'), which would
 * silently treat a model as its predecessor. Handles suffixed IDs such as
 * 'claude-opus-5[1m]' and dated snapshots.
 */
export function pricingKeyForModel(modelId: string): string | null {
  let bestKey: string | null = null
  let bestLen = -1
  for (const key of Object.keys(MODEL_PRICING)) {
    if (modelId.startsWith(key) && key.length > bestLen) {
      bestKey = key
      bestLen = key.length
    }
  }
  return bestKey
}

/**
 * Detect model from assistant record and return appropriate pricing.
 *
 * Rates come back scaled by the configured discount, which is zero unless
 * the user set one: see applyDiscount. The model matching itself lives in
 * pricingKeyForModel.
 */
export function getPricingForModel(modelId: string): PricingConfig {
  const key = pricingKeyForModel(modelId)
  if (key) return pricingForKey(key)

  // Nothing on the Anthropic bill: local models via Ollama or LM Studio, and
  // Claude Code's own '<synthetic>' marker. Pricing these as Claude inflated
  // every total containing a subagent on a local model. Not discounted
  // either: a fraction off zero is zero, and scaling it would replace a
  // shared sentinel with a copy of itself.
  if (!modelId.startsWith('claude-')) return ZERO_PRICING

  // Unknown model. Never fail silently: an unpriced model used to fall through
  // to mid-tier pricing, which understated real spend without any signal.
  if (!warnedUnknownModels.has(modelId)) {
    warnedUnknownModels.add(modelId)
    process.emitWarning(
      `clauditor: no pricing entry for model "${modelId}"; ` +
        `costs are estimated using ${FALLBACK_PRICING_MODEL} rates and may be too high.`
    )
  }
  return pricingForKey(FALLBACK_PRICING_MODEL)
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

/**
 * Cost-weighted size of a single turn, in dollars.
 *
 * Use this, never the face-value token sum, whenever turns are being compared
 * to each other. The four token classes differ in price by up to 20x: a cache
 * read costs 0.1x base input while a 1-hour cache write costs 2x. Summing them
 * at face value makes a healthy cache-warm session - which is mostly cheap
 * reads - look like runaway spend, and understates a cold session that is
 * mostly expensive writes.
 */
export function effectiveTurnCost(
  usage: TokenUsage,
  pricing?: PricingConfig
): number {
  return estimateCost(usage, pricing).totalCost
}

/**
 * Face-value token count for a turn. Display only - it is what the context
 * window holds, not what the turn costs. Never compare turns with it.
 */
export function rawTurnTokens(usage: TokenUsage): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens
  )
}

/**
 * Input context a turn was billed to carry.
 *
 * The three input classes and deliberately not output: this is what a cold
 * session would have to rewrite, and output is never re-read. Distinct from
 * rawTurnTokens above, which adds output and is display-only. The two are one
 * `output_tokens` apart, so a copy of either is impossible to tell apart on
 * sight, which is why this one is named.
 *
 * journal.ts is the only caller so far. The same sum is still open-coded in
 * cli.ts, cache-health.ts, impact-tracker.ts, daemon/parser.ts and
 * post-tool-use.ts; those are unconverted, not covered by this.
 */
export function contextTokens(usage: TokenUsage): number {
  return (
    usage.input_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens
  )
}

