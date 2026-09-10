import { describe, it, expect } from 'vitest'
import {
  buildResumeAdvisory,
  RESUME_BREAK_EVEN,
  HANDOFF_ENTRY_TOKENS,
  type ResumeAdvisoryInput,
} from './resume-advisory.js'
import { CACHE_TTL_MS } from './journal.js'

const HOUR = 60 * 60 * 1000
const PATH = '/Users/x/.claude/handoffs/handoff-thing-20260910-1419.md'

/** A cold, comfortably-over-threshold bank: the case the advisory exists for. */
function banked(over: Partial<ResumeAdvisoryInput> = {}): ResumeAdvisoryInput {
  return {
    kind: 'augmented',
    path: PATH,
    peakContext: 179_200,
    ageMs: 3 * HOUR,
    model: 'claude-opus-5',
    ...over,
  }
}

describe('buildResumeAdvisory', () => {
  it('says nothing for a mechanical journal', () => {
    expect(buildResumeAdvisory(banked({ kind: 'mechanical' }))).toBeNull()
  })

  it('says nothing when there is no summary at all', () => {
    expect(buildResumeAdvisory(banked({ kind: 'none' }))).toBeNull()
  })

  it('says nothing without a path to paste', () => {
    expect(buildResumeAdvisory(banked({ path: null }))).toBeNull()
  })

  // The advisory is a cold-cache feature. While the cache is warm, resuming
  // reads the conversation back at a tenth of the price and the handoff is
  // not needed.
  it('says nothing while the cache is still warm', () => {
    expect(buildResumeAdvisory(banked({ ageMs: CACHE_TTL_MS - 1 }))).toBeNull()
  })

  it('speaks once the cache has gone cold', () => {
    expect(buildResumeAdvisory(banked({ ageMs: CACHE_TTL_MS + 1 }))).not.toBeNull()
  })

  it('says nothing when the banked session was below the break-even', () => {
    expect(buildResumeAdvisory(banked({ peakContext: RESUME_BREAK_EVEN - 1 }))).toBeNull()
  })

  describe('the cold advisory', () => {
    const msg = buildResumeAdvisory(banked())!

    it('is addressed to the user, not the model', () => {
      expect(msg.startsWith('[clauditor]:')).toBe(true)
    })

    it('states the peak and how long ago it was', () => {
      expect(msg).toContain('peaked at 179k tokens 3h ago')
    })

    it('states what resuming the cold conversation would cost', () => {
      expect(msg).toContain('cost ~179k tokens plus the token cost of your message')
    })

    it('states the saving in tokens and in money', () => {
      // 179,200 peak less the 50,362 measured entry cost of a handoff start.
      expect(msg).toContain('save ~129k tokens')
      // Both legs are cache writes, billed at the 1h rate: 10.00/M for opus-5.
      expect(msg).toContain('($1.29)')
    })

    it('prices by the banking session model, not a fixed one', () => {
      // fable-5-1 writes at 20.00/M, exactly double opus-5, so the saving doubles.
      const fable = buildResumeAdvisory(banked({ model: 'claude-fable-5-1' }))!
      expect(fable).toContain('($2.58)')
    })

    it('hands over the paste-able prompt, quoting the promoted path', () => {
      expect(msg).toContain('Continue a paused task. Read ' + PATH + ' in full')
      expect(msg).toContain('Do not touch')
      expect(msg).toContain('stop and tell me the handoff is stale')
    })

    // Claude Code truncates systemMessage at 4,000 characters and 20 lines.
    it('fits inside the systemMessage cap', () => {
      expect(msg.length).toBeLessThanOrEqual(4000)
      expect(msg.split('\n').length).toBeLessThanOrEqual(20)
    })
  })

  describe('a hand-written handoff, which has no measured peak', () => {
    const msg = buildResumeAdvisory({
      kind: 'augmented',
      path: PATH,
      peakContext: 0,
      ageMs: null,
    })!

    it('is still offered, because writing one by hand is the signal', () => {
      expect(msg).not.toBeNull()
      expect(msg).toContain(PATH)
    })

    it('invents no figures it cannot measure', () => {
      expect(msg).not.toContain('peaked at')
      expect(msg).not.toContain('$')
      expect(msg).not.toContain('undefined')
      expect(msg).not.toContain('NaN')
    })

    it('fits inside the systemMessage cap', () => {
      expect(msg.length).toBeLessThanOrEqual(4000)
      expect(msg.split('\n').length).toBeLessThanOrEqual(20)
    })
  })

  it('exposes the entry cost it subtracts, so the maths can be checked', () => {
    expect(HANDOFF_ENTRY_TOKENS).toBeGreaterThan(0)
    expect(RESUME_BREAK_EVEN).toBeGreaterThan(HANDOFF_ENTRY_TOKENS)
  })
})
