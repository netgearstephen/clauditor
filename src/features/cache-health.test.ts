import { describe, it, expect } from 'vitest'
import { detectCacheDegradation } from './cache-health.js'
import type { TurnMetrics } from '../types.js'

function makeTurn(
  turnIndex: number,
  input: number,
  cacheCreate: number,
  cacheRead: number
): TurnMetrics {
  const total = input + cacheCreate + cacheRead
  return {
    turnIndex,
    timestamp: `2025-01-01T00:0${turnIndex}:00Z`,
    usage: {
      input_tokens: input,
      output_tokens: 50,
      cache_creation_input_tokens: cacheCreate,
      cache_read_input_tokens: cacheRead,
    },
    cacheRatio: total > 0 ? cacheRead / total : 0,
    toolCalls: [],
  }
}

describe('detectCacheDegradation', () => {
  it('returns unknown for fewer than 3 turns', () => {
    const turns = [makeTurn(0, 100, 200, 0), makeTurn(1, 50, 100, 300)]
    const result = detectCacheDegradation(turns)
    expect(result.status).toBe('unknown')
    expect(result.degradationDetected).toBe(false)
  })

  it('stays unknown while the session is still warming up', () => {
    // The prefix must be written before it can be read, so the opening turns
    // are structurally write-heavy. That is warm-up, not degradation.
    const turns = [
      makeTurn(0, 100, 500, 0),
      makeTurn(1, 100, 400, 100),
      makeTurn(2, 100, 300, 200),
    ]
    const result = detectCacheDegradation(turns)
    expect(result.status).toBe('unknown')
    expect(result.degradationDetected).toBe(false)
  })

  it('detects healthy cache with high ratio', () => {
    const turns = [
      makeTurn(0, 100, 500, 0),
      ...Array.from({ length: 9 }, (_, i) =>
        makeTurn(i + 1, 50, 50, 5000 + i * 500)
      ),
    ]
    const result = detectCacheDegradation(turns)
    expect(result.status).toBe('healthy')
    expect(result.degradationDetected).toBe(false)
    expect(result.lastCacheRatio).toBeGreaterThan(0.7)
  })

  it('detects broken cache - flat cache_read + growing cache_creation', () => {
    const turns = Array.from({ length: 10 }, (_, i) =>
      makeTurn(i, 100, 1000 + i * 1000, 50)
    )
    const result = detectCacheDegradation(turns)
    expect(result.status).toBe('broken')
    expect(result.degradationDetected).toBe(true)
  })

  it('detects genuinely degraded cache sustained across the window', () => {
    const turns = [
      ...Array.from({ length: 6 }, (_, i) => makeTurn(i, 50, 50, 8000)),
      ...Array.from({ length: 5 }, (_, i) => makeTurn(i + 6, 100, 4000, 500)),
    ]
    const result = detectCacheDegradation(turns)
    expect(result.status).toBe('degraded')
  })

  it('does not flag a healthy session for one write-heavy turn', () => {
    // Regression: the verdict used to come from the final turn alone, so a
    // single large file read, compaction or resume marked a session sitting
    // above 95% as degraded. This is what produced 51 false positives in
    // `clauditor doctor` against sessions whose aggregate never dropped
    // below 77%.
    const turns = [
      makeTurn(0, 100, 500, 0),
      ...Array.from({ length: 20 }, (_, i) =>
        makeTurn(i + 1, 50, 1500, 180_000)
      ),
      makeTurn(21, 50, 120_000, 4000), // a big file lands in context
    ]
    const result = detectCacheDegradation(turns)
    expect(result.status).toBe('healthy')
    expect(result.degradationDetected).toBe(false)
  })

  it('weights the window by volume rather than averaging turn ratios', () => {
    // A tiny turn with a poor ratio must not outweigh large healthy ones.
    const turns = [
      ...Array.from({ length: 10 }, (_, i) => makeTurn(i, 50, 500, 200_000)),
      makeTurn(10, 10, 90, 10),
    ]
    const result = detectCacheDegradation(turns)
    expect(result.status).toBe('healthy')
  })

  it('includes cache ratio trend', () => {
    const turns = [
      makeTurn(0, 100, 500, 0),
      makeTurn(1, 50, 100, 800),
      makeTurn(2, 50, 50, 2000),
    ]
    const result = detectCacheDegradation(turns)
    expect(result.cacheRatioTrend).toHaveLength(3)
  })
})
