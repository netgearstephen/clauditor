import type { TokenUsage } from '../types.js'
import { estimateCost, getPricingForModel } from './cost-tracker.js'
import { CACHE_TTL_MS } from './journal.js'

/**
 * The advisory a new session shows when a cold conversation left a handoff
 * behind.
 *
 * It goes to the user as `systemMessage`, never as `additionalContext`.
 * `additionalContext` reaches the user only by way of a model turn, and that
 * turn is the rewrite the advisory exists to prevent: the point is to hand
 * over a prompt without paying a model to read the handoff first.
 *
 * Pure by design. Everything it needs is passed in, so the wording and the
 * arithmetic can be tested without a transcript, a hook or a clock.
 */

/**
 * Peak context below which resuming is not worth the handoff's entry cost.
 *
 * A fresh session's own floor is about 50k, so a conversation not appreciably
 * larger than that floor has nothing worth carrying: the entry cost of
 * loading the handoff eats the whole saving. Measured at 63,620 against the
 * observed reuse rate, rounded to 65,000.
 */
export const RESUME_BREAK_EVEN = 65_000

/**
 * What starting a session from a handoff costs, in tokens.
 *
 * Median over the measured sessions that did it, almost all of it cache
 * write. This is the figure subtracted from the cold conversation's peak to
 * get the saving quoted to the user.
 */
export const HANDOFF_ENTRY_TOKENS = 50_362

export interface ResumeAdvisoryInput {
  /** What kind of summary is on offer. Only 'augmented' is ever advertised. */
  kind: 'augmented' | 'mechanical' | 'none'
  /** Promoted handoff path, quoted verbatim in the paste prompt. */
  path: string | null
  /** Peak context of the session that banked it; 0 when never measured. */
  peakContext: number
  /** Milliseconds since that session's last turn; null when unknown. */
  ageMs: number | null
  /** Model the banking session ran, for pricing. Defaults to the fallback. */
  model?: string
}

/** The prompt the user pastes into the new session. */
function pastePrompt(path: string): string {
  return (
    `Continue a paused task. Read ${path} in full before doing anything else. ` +
    `Then summarise your understanding back to me in 3 to 5 bullets and confirm ` +
    `the very next step. Do not redo any work the file marks as complete. Do not ` +
    `modify anything listed under "Do not touch". Run the verification command ` +
    `first, and if its output does not match what the handoff records, stop and ` +
    `tell me the handoff is stale rather than guessing.`
  )
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/**
 * Dollar cost of writing `tokens` into a cold prompt cache.
 *
 * Routed through estimateCost rather than multiplied out here, so the advisory
 * cannot drift from what the rest of the tool charges. Leaving the
 * cache_creation breakdown unset bills the whole amount at the 1h rate, which
 * is the TTL these sessions actually use.
 */
function cacheWriteCost(tokens: number, model?: string): number {
  const usage: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: tokens,
    cache_read_input_tokens: 0,
  }
  return estimateCost(usage, getPricingForModel(model ?? '')).totalCost
}

/**
 * The advisory text, or null when there is nothing worth saying.
 *
 * Silent unless every condition holds: the summary carries judgement, there is
 * a path to paste, and the cache has gone cold. A warm cache needs no advisory
 * because resuming reads the conversation back at a tenth of the price.
 */
export function buildResumeAdvisory(input: ResumeAdvisoryInput): string | null {
  const { kind, path, peakContext, ageMs, model } = input

  if (kind !== 'augmented' || !path) return null

  // A hand-written handoff has no measured peak and no session to age. It is
  // offered anyway: writing one by hand is a stronger signal than any
  // arithmetic. Without the measurements it states no figures at all.
  const measured = peakContext > 0 && ageMs !== null
  if (!measured) {
    return (
      `[clauditor]: A handoff you wrote is waiting for this project. ` +
      `Paste this prompt into a new session to pick it up:\n\n` +
      pastePrompt(path)
    )
  }

  if (ageMs < CACHE_TTL_MS) return null
  if (peakContext < RESUME_BREAK_EVEN) return null

  const savedTokens = peakContext - HANDOFF_ENTRY_TOKENS
  const savedCost =
    cacheWriteCost(peakContext, model) - cacheWriteCost(HANDOFF_ENTRY_TOKENS, model)

  return (
    `[clauditor]: Your session peaked at ${formatTokens(peakContext)} tokens ` +
    `${formatAge(ageMs)} ago. The cache is now cold, so resuming the conversation ` +
    `will cost ~${formatTokens(peakContext)} tokens plus the token cost of your ` +
    `message.\n\n` +
    `Your conversation created a handoff while the cache was still warm. You can ` +
    `save ~${formatTokens(savedTokens)} tokens ($${savedCost.toFixed(2)}) while ` +
    `still passing along the context by pasting this prompt into a new ` +
    `session:\n\n` +
    pastePrompt(path)
  )
}
