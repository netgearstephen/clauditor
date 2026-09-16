import { readConfig, type ClauditorUserConfig } from '../config.js'
import { MODEL_PRICING } from '../types.js'
import { pricingKeyForModel } from './cost-tracker.js'

/**
 * How much of a model's window a gate is allowed to sit at.
 *
 * Nine tenths. A gate at the window itself is reachable only by the session
 * that never reaches it, since Claude Code compacts before the wall, and the
 * point of the clamp is a gate that can actually fire.
 */
export const WINDOW_FRACTION = 0.9

export interface ResolvedTrigger {
  /** The configured gate, before the buffer and before any clamp. */
  peakContext: number
  buffer: number
  minRequestsSinceBank: number
  /** What the peak is actually compared against. The only number to use. */
  gate: number
  /** The ceiling, when the window forced one, else null. */
  clampedTo: number | null
}

/** Models already warned about, so a clamp is reported once, not per turn. */
const warnedClampedModels = new Set<string>()

export function resetTriggerWarnings(): void {
  warnedClampedModels.clear()
}

/**
 * Work out what this session's peak has to beat before its judgement is
 * banked, and how many requests must have passed since its last bank.
 *
 * Layered, and resolved field by field: a per-model override naming only the
 * request floor must not take the peak gate back to the default with it.
 * Overrides are keyed by the same longest-prefix model key as the pricing
 * table, through pricingKeyForModel, so the codebase has one model-key rule.
 *
 * The clamp is the part that is not merely arithmetic. A gate above the
 * model's context window is not a late gate, it is no gate: the peak can
 * never reach it, so the session banks nothing and says nothing about why.
 * Clamping and warning once is the only behaviour that fails loudly. A window
 * that is not known is left unclamped, because clamping against a guess would
 * move a gate the user chose.
 */
export function resolveTrigger(
  modelId: string | null,
  config: ClauditorUserConfig = readConfig()
): ResolvedTrigger {
  const trigger = config.rotation.trigger
  const key = modelId ? pricingKeyForModel(modelId) : null
  const override = key ? trigger.perModel[key] : undefined

  const peakContext = override?.peakContext ?? trigger.peakContext
  const buffer = override?.buffer ?? trigger.buffer
  const minRequestsSinceBank = override?.minRequestsSinceBank ?? trigger.minRequestsSinceBank

  const wanted = peakContext - buffer
  const window = key ? MODEL_PRICING[key]?.windowTokens : undefined
  const ceiling = window === undefined ? Infinity : window * WINDOW_FRACTION

  if (wanted <= ceiling) {
    return { peakContext, buffer, minRequestsSinceBank, gate: wanted, clampedTo: null }
  }

  if (key && !warnedClampedModels.has(key)) {
    warnedClampedModels.add(key)
    process.emitWarning(
      `clauditor: the banking gate of ${wanted.toLocaleString('en-GB')} tokens is above ` +
        `${key}'s usable window, so it could never fire; using ` +
        `${ceiling.toLocaleString('en-GB')} instead.`
    )
  }

  return { peakContext, buffer, minRequestsSinceBank, gate: ceiling, clampedTo: ceiling }
}
