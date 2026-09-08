import type { CacheHealth, TurnMetrics } from '../types.js'

/**
 * Detect cache degradation from turn metrics.
 *
 * This detects a well-documented pattern reported in the Claude Code community:
 * after session resume, cache_read_input_tokens stops growing while
 * cache_creation_input_tokens keeps increasing — meaning conversation history
 * is reprocessed from scratch instead of reading from cache.
 *
 * Detection is based entirely on observable patterns in JSONL session files.
 */
/** Turns in the trailing window used to judge health. */
const HEALTH_WINDOW = 5

/** A session shorter than this is still warming up; early turns are all writes. */
const MIN_TURNS_FOR_VERDICT = 8

/**
 * Aggregate cache hit ratio across a set of turns.
 *
 * Aggregating is not the same as averaging per-turn ratios: a turn that reads
 * 200k and one that reads 2k should not carry equal weight.
 */
function windowCacheRatio(turns: TurnMetrics[]): number {
  let read = 0
  let billed = 0
  for (const t of turns) {
    read += t.usage.cache_read_input_tokens
    billed +=
      t.usage.cache_read_input_tokens +
      t.usage.cache_creation_input_tokens +
      t.usage.input_tokens
  }
  return billed > 0 ? read / billed : 0
}

export function detectCacheDegradation(turns: TurnMetrics[]): CacheHealth {
  if (turns.length < 3) {
    return {
      status: 'unknown',
      lastCacheRatio: turns.length > 0 ? turns[turns.length - 1].cacheRatio : 0,
      cacheRatioTrend: turns.map((t) => t.cacheRatio),
      degradationDetected: false,
    }
  }

  const recentTurns = turns.slice(-HEALTH_WINDOW)
  const cacheReadValues = recentTurns.map(
    (t) => t.usage.cache_read_input_tokens
  )
  const cacheCreateValues = recentTurns.map(
    (t) => t.usage.cache_creation_input_tokens
  )

  // Judge on the aggregate of the trailing window, not on the final turn.
  // A single turn is a terrible estimator: one large file read, a compaction
  // or a resume produces a write-heavy turn whose ratio is near zero while the
  // session as a whole sits above 95%. Using it directly reported healthy
  // sessions as degraded en masse.
  const windowRatio = windowCacheRatio(recentTurns)
  const lastRatio = recentTurns[recentTurns.length - 1]?.cacheRatio ?? 0

  // Degradation signature: cache_read is flat (low variance) while
  // cache_creation keeps growing - history is being reprocessed rather than
  // read back.
  const cacheReadVariance =
    Math.max(...cacheReadValues) - Math.min(...cacheReadValues)
  const cacheCreateGrowing =
    cacheCreateValues[cacheCreateValues.length - 1] >
    cacheCreateValues[0] * 1.5

  const degraded =
    cacheReadVariance < 500 &&
    cacheCreateGrowing &&
    windowRatio < 0.5 &&
    turns.length >= MIN_TURNS_FOR_VERDICT

  // Early turns are structurally write-heavy: the prefix has to be written
  // before it can be read. Calling that degradation is noise, not signal.
  const status: CacheHealth['status'] = degraded
    ? 'broken'
    : turns.length < MIN_TURNS_FOR_VERDICT
      ? 'unknown'
      : windowRatio >= 0.7
        ? 'healthy'
        : 'degraded'

  return {
    status,
    degradationDetected: degraded,
    lastCacheRatio: windowRatio,
    cacheRatioTrend: recentTurns.map((t) => t.cacheRatio),
  }
}

/**
 * Format a cache health status for display.
 */
export function formatCacheStatus(health: CacheHealth): string {
  switch (health.status) {
    case 'healthy':
      return `✓ healthy (${(health.lastCacheRatio * 100).toFixed(0)}% cache hit)`
    case 'degraded':
      return `⚠ degraded (${(health.lastCacheRatio * 100).toFixed(0)}% cache hit, last ${HEALTH_WINDOW} turns)`
    case 'broken':
      return `✗ broken — cache reprocessing detected`
    case 'unknown':
      return `? warming up`
  }
}

/**
 * Generate the degradation alert message.
 */
export function getCacheDegradationAlert(): string {
  return (
    '⚠️ Cache degradation detected — this session is reprocessing history ' +
    'as new tokens each turn. This can inflate costs 10-20x. ' +
    'Recommended: run `/clear` and re-state your context, or start a fresh session.'
  )
}
