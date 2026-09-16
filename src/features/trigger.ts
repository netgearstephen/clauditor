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

/**
 * Fallback gate used only when peakContext minus buffer cannot be trusted at
 * all (non-finite, from a non-numeric knob upstream, since config.ts passes
 * JSON straight through with no validation). Mirrors the built-in default at
 * DEFAULTS.rotation.trigger.peakContext in src/config.ts; kept as a local
 * constant rather than imported so this module does not reach into config
 * internals for one number.
 */
const FALLBACK_PEAK_CONTEXT = 150_000

/**
 * Problems already warned about, keyed by what went wrong plus which model
 * it happened for, so each distinct problem is reported once per model per
 * process rather than once per turn within that process. A hook is a fresh
 * process every turn, so this buys one warning per model per process, not
 * one warning for the lifetime of a session.
 */
const warned = new Set<string>()

export function resetTriggerWarnings(): void {
  warned.clear()
}

function warnOnce(dedupeKey: string, message: string): void {
  if (warned.has(dedupeKey)) return
  warned.add(dedupeKey)
  process.emitWarning(message)
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
 *
 * modelId from readTurns is the session's FIRST model, not its current one,
 * so a session that switched gets the override and window clamp of the model
 * it started on. Inert under the shipped defaults.
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
  const rawFloor = override?.minRequestsSinceBank ?? trigger.minRequestsSinceBank

  // The label a warning names the model by. key is the resolved pricing key
  // when there is one; modelId carries an unmatched model through instead of
  // dropping to silence, and there is a label even with no model at all,
  // because a misconfigured gate must be loud whether or not it is keyed.
  const modelLabel = key ?? modelId ?? '(no model)'

  // config performs no coercion, so "abc" reaches turns - banked < NaN, which
  // is false and removes the floor silently. Falls open to 0 rather than
  // closed: a broken floor must not be able to stop banking altogether.
  let minRequestsSinceBank: number
  if (Number.isFinite(rawFloor) && rawFloor >= 0) {
    minRequestsSinceBank = Number(rawFloor)
  } else {
    minRequestsSinceBank = 0
    warnOnce(
      `floor:${modelLabel}`,
      `clauditor: the trigger's minRequestsSinceBank for ${modelLabel} is not a number of zero or ` +
        `more; using a floor of 0 instead, which allows banking as soon as the gate is met.`
    )
  }

  const rawWanted = peakContext - buffer
  let wanted: number
  if (!Number.isFinite(rawWanted)) {
    // A non-numeric knob upstream makes peakContext - buffer NaN or
    // infinite. A gate like that can never fire, which is exactly the
    // silent failure this whole module exists to prevent, so it does not
    // reach the caller: fall back to the top-level peak, or to the built-in
    // default when even that is not trustworthy.
    wanted = Number.isFinite(trigger.peakContext)
      ? Math.max(0, trigger.peakContext)
      : FALLBACK_PEAK_CONTEXT
    warnOnce(
      `nonfinite:${modelLabel}`,
      `clauditor: the banking gate resolved to a non-numeric value for ${modelLabel}; check ` +
        `the trigger's peakContext and buffer, falling back to ${wanted.toLocaleString('en-GB')} tokens.`
    )
  } else if (rawWanted < 0) {
    // A buffer larger than the peak. Every session's peak would beat a
    // negative gate on its first turn, which is the same unreachable-gate
    // failure the window clamp guards against, arrived at from below.
    wanted = 0
    warnOnce(
      `negative:${modelLabel}`,
      // Phrased around the resolved gate rather than around the buffer: with a
      // negative peakContext the buffer is not the culprit, and naming it
      // sends the reader to the wrong knob.
      `clauditor: the banking gate for ${modelLabel} resolved to ` +
        `${rawWanted.toLocaleString('en-GB')} (peakContext ${peakContext.toLocaleString('en-GB')} ` +
        `minus buffer ${buffer.toLocaleString('en-GB')}); using a gate of 0 instead.`
    )
  } else {
    wanted = rawWanted
  }

  const window = key ? MODEL_PRICING[key]?.windowTokens : undefined
  if (window === undefined) {
    // Unknown stays unknown. Never treated as unlimited: clamping a gate the
    // user configured against a guessed window would be worse than not
    // clamping at all.
    return { peakContext, buffer, minRequestsSinceBank, gate: wanted, clampedTo: null }
  }

  const ceiling = window * WINDOW_FRACTION
  if (wanted <= ceiling) {
    return { peakContext, buffer, minRequestsSinceBank, gate: wanted, clampedTo: null }
  }

  warnOnce(
    `window:${key}`,
    `clauditor: the banking gate of ${wanted.toLocaleString('en-GB')} tokens is above ` +
      `${key}'s usable window, so it could never fire; using ` +
      `${ceiling.toLocaleString('en-GB')} instead.`
  )

  return { peakContext, buffer, minRequestsSinceBank, gate: ceiling, clampedTo: ceiling }
}
