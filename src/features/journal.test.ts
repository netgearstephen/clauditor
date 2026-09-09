import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, utimesSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Each test needs a fresh import to pick up the mocked homedir. */
async function importFresh(tempDir: string) {
  vi.resetModules()
  vi.doMock('node:os', () => ({ homedir: () => tempDir }))
  return await import('./journal.js')
}

const CWD = '/home/user/project-a'

function transcriptWith(timestamps: string[], dir: string): string {
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(
    path,
    timestamps
      .map((ts) => JSON.stringify({ type: 'assistant', timestamp: ts }))
      .join('\n')
  )
  return path
}

/** Write a handoff of the shape the /handoff skill produces. */
function writeUserHandoff(
  home: string,
  repo: string,
  body: string,
  mtimeMs: number,
  slug = 'task'
): string {
  const dir = join(home, '.claude', 'handoffs')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${slug}-20260908-1303.md`)
  writeFileSync(
    path,
    `# Handoff: ${body}\n\n**Repo**: ${repo}\n**Branch**: main\n\n## Mission\n${body}\n`
  )
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
  return path
}

/** Turns whose context sizes are exactly as given. */
function turnsWith(...contexts: number[]) {
  return contexts.map((c, i) => ({
    turnIndex: i,
    timestamp: `2026-09-08T10:0${i}:00Z`,
    usage: {
      input_tokens: 2,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: c - 2,
    },
    cacheRatio: 1,
    toolCalls: [],
  }))
}

describe('journal', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-journal-'))
  })

  afterEach(() => {
    vi.doUnmock('node:os')
    vi.resetModules()
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('msSinceLastTurn', () => {
    it('measures from the last timestamped record, not the first', async () => {
      const { msSinceLastTurn } = await importFresh(tempDir)
      const path = transcriptWith(
        ['2026-09-08T10:00:00Z', '2026-09-08T10:30:00Z'],
        tempDir
      )
      const now = Date.parse('2026-09-08T10:40:00Z')
      expect(msSinceLastTurn(path, now)).toBe(10 * 60 * 1000)
    })

    it('returns null when there is no transcript to read', async () => {
      const { msSinceLastTurn } = await importFresh(tempDir)
      expect(msSinceLastTurn(null)).toBeNull()
      expect(msSinceLastTurn(join(tempDir, 'absent.jsonl'))).toBeNull()
    })
  })

  describe('isCacheWarm', () => {
    it('is warm inside the TTL and cold outside it', async () => {
      const { isCacheWarm } = await importFresh(tempDir)
      const path = transcriptWith(['2026-09-08T10:00:00Z'], tempDir)
      expect(isCacheWarm(path, Date.parse('2026-09-08T10:59:00Z'))).toBe(true)
      expect(isCacheWarm(path, Date.parse('2026-09-08T11:01:00Z'))).toBe(false)
    })

    it('treats unknown as warm', async () => {
      const { isCacheWarm } = await importFresh(tempDir)
      // Banking a warm turn that turns out cold wastes one cheap turn.
      // Skipping it leaves the session with no handoff at all.
      expect(isCacheWarm(null)).toBe(true)
    })
  })

  describe('shouldWriteJournal', () => {
    it('writes when there is no journal yet', async () => {
      const { shouldWriteJournal } = await importFresh(tempDir)
      const state = { lastWriteAt: 0, lastFingerprint: '', bankedAt: 0, bankedAtTurn: 0, promotedAt: 0 }
      expect(shouldWriteJournal(state, 'anything', 1000)).toBe(true)
    })

    it('writes when the session moved', async () => {
      const { shouldWriteJournal } = await importFresh(tempDir)
      const state = { lastWriteAt: 1000, lastFingerprint: 'a', bankedAt: 0, bankedAtTurn: 0, promotedAt: 0 }
      expect(shouldWriteJournal(state, 'b', 2000)).toBe(true)
    })

    it('skips when nothing changed and the journal is fresh', async () => {
      const { shouldWriteJournal } = await importFresh(tempDir)
      const state = { lastWriteAt: 1000, lastFingerprint: 'a', bankedAt: 0, bankedAtTurn: 0, promotedAt: 0 }
      expect(shouldWriteJournal(state, 'a', 1000 + 60_000)).toBe(false)
    })

    it('writes anyway once the staleness cap is passed', async () => {
      const { shouldWriteJournal } = await importFresh(tempDir)
      // Standing in for "before the cache expires", which cannot be predicted:
      // a cache dies during idleness, when no hook fires.
      const state = { lastWriteAt: 1000, lastFingerprint: 'a', bankedAt: 0, bankedAtTurn: 0, promotedAt: 0 }
      expect(shouldWriteJournal(state, 'a', 1000 + 16 * 60_000)).toBe(true)
    })
  })

  describe('peakContextTokens', () => {
    it('is the largest context any turn was charged for', async () => {
      const { peakContextTokens } = await importFresh(tempDir)
      // Not the last turn: a session that compacts drops back down, and the
      // cold rewrite it avoids is priced on the high-water mark.
      expect(peakContextTokens(turnsWith(50_000, 240_000, 90_000))).toBe(240_000)
    })

    it('counts cache writes as context, not just reads', async () => {
      const { peakContextTokens } = await importFresh(tempDir)
      const turns = [
        {
          turnIndex: 0,
          timestamp: '2026-09-08T10:00:00Z',
          usage: {
            input_tokens: 1_000,
            output_tokens: 10,
            cache_creation_input_tokens: 199_000,
            cache_read_input_tokens: 0,
          },
          cacheRatio: 0,
          toolCalls: [],
        },
      ]
      expect(peakContextTokens(turns)).toBe(200_000)
    })

    it('is zero for a session with no turns', async () => {
      const { peakContextTokens } = await importFresh(tempDir)
      expect(peakContextTokens([])).toBe(0)
    })
  })

  describe('shouldBankHandoff', () => {
    const fresh = { lastWriteAt: 0, lastFingerprint: '', bankedAt: 0, bankedAtTurn: 0, promotedAt: 0 }
    const warm = Date.parse('2026-09-08T10:10:00Z')

    it('banks once peak context reaches the threshold and the cache is warm', async () => {
      const { shouldBankHandoff } = await importFresh(tempDir)
      const path = transcriptWith(['2026-09-08T10:00:00Z'], tempDir)
      expect(shouldBankHandoff(fresh, 200_000, 200_000, path, warm)).toBe(true)
    })

    it('does not bank below the threshold', async () => {
      const { shouldBankHandoff } = await importFresh(tempDir)
      // Measured over 1,476 sessions: below ~200k the fixed cost of writing
      // the document outruns the 1.9x saved on the context it avoids
      // rewriting, so banking every such session loses tokens overall.
      const path = transcriptWith(['2026-09-08T10:00:00Z'], tempDir)
      expect(shouldBankHandoff(fresh, 199_999, 200_000, path, warm)).toBe(false)
    })

    it('banks a short session that is already huge', async () => {
      const { shouldBankHandoff } = await importFresh(tempDir)
      // Turn count is not the gate. What a cold rewrite would cost depends on
      // context size alone, and a few enormous file reads get there fast.
      const path = transcriptWith(['2026-09-08T10:00:00Z'], tempDir)
      expect(shouldBankHandoff(fresh, 400_000, 200_000, path, warm)).toBe(true)
    })

    it('never banks twice in a session', async () => {
      const { shouldBankHandoff } = await importFresh(tempDir)
      const path = transcriptWith(['2026-09-08T10:00:00Z'], tempDir)
      const banked = { ...fresh, bankedAt: 123, bankedAtTurn: 70 }
      expect(shouldBankHandoff(banked, 400_000, 200_000, path, warm)).toBe(false)
    })

    it('does not bank once the cache is cold', async () => {
      const { shouldBankHandoff } = await importFresh(tempDir)
      // The whole point of banking early: cold, the same document costs 2x on
      // the context instead of 0.1x, and there is nothing left to save.
      const path = transcriptWith(['2026-09-08T10:00:00Z'], tempDir)
      const cold = Date.parse('2026-09-08T11:30:00Z')
      expect(shouldBankHandoff(fresh, 400_000, 200_000, path, cold)).toBe(false)
    })
  })

  describe('capturePendingHandoff', () => {
    it('stores the judgement and strips the marker', async () => {
      const j = await importFresh(tempDir)
      const body = `## Mission\n${'Ship the thing. '.repeat(20)}`
      expect(j.capturePendingHandoff(CWD, 80, `${body}\n${j.BANK_MARKER}`)).toBe(true)

      const stored = j.offerSummary(null, CWD)
      expect(stored.kind).toBe('augmented')
      expect(stored.content).toContain('## Mission')
      expect(stored.content).not.toContain(j.BANK_MARKER)
    })

    it('records that the session has banked, so it cannot bank again', async () => {
      const j = await importFresh(tempDir)
      j.capturePendingHandoff(CWD, 80, `## Mission\n${'x'.repeat(200)}\n${j.BANK_MARKER}`)
      expect(j.readJournalState(CWD).bankedAt).toBeGreaterThan(0)
      expect(j.readJournalState(CWD).bankedAtTurn).toBe(80)
    })

    it('rejects a reply too short to be a handoff', async () => {
      const j = await importFresh(tempDir)
      expect(j.capturePendingHandoff(CWD, 80, `ok ${j.BANK_MARKER}`)).toBe(false)
      expect(existsSync(j.pendingHandoffPath(CWD))).toBe(false)
    })
  })

  describe('offerSummary', () => {
    it('offers nothing when there is nothing to offer', async () => {
      const j = await importFresh(tempDir)
      expect(j.offerSummary(null, CWD).kind).toBe('none')
    })

    it('offers the mechanical journal when only that exists', async () => {
      const j = await importFresh(tempDir)
      mkdirSync(j.journalDir(CWD), { recursive: true })
      writeFileSync(j.journalPath(CWD), '# Session journal\n\n**Branch**: main\n')

      const offered = j.offerSummary(null, CWD)
      expect(offered.kind).toBe('mechanical')
      expect(offered.content).toContain('**Branch**: main')
    })

    it('prefers the banked judgement even when the journal is newer', async () => {
      const j = await importFresh(tempDir)
      // The augmented summary regenerates its facts at read time, so a newer
      // journal never makes it the staler of the two.
      j.capturePendingHandoff(CWD, 80, `## Mission\n${'x'.repeat(200)}\n${j.BANK_MARKER}`)
      mkdirSync(j.journalDir(CWD), { recursive: true })
      writeFileSync(j.journalPath(CWD), '# Session journal\n\nwritten later\n')

      expect(j.offerSummary(null, CWD).kind).toBe('augmented')
    })

    it('keeps projects apart', async () => {
      const j = await importFresh(tempDir)
      j.capturePendingHandoff(CWD, 80, `## Mission\n${'x'.repeat(200)}\n${j.BANK_MARKER}`)
      expect(j.offerSummary(null, '/home/user/project-b').kind).toBe('none')
    })

    it('prefers a hand-written handoff to an older banked one', async () => {
      const j = await importFresh(tempDir)
      j.capturePendingHandoff(CWD, 80, `## Mission\nbanked\n${'x'.repeat(200)}\n${j.BANK_MARKER}`)
      writeUserHandoff(tempDir, CWD, 'hand-written', Date.now() + 60_000)

      const offered = j.offerSummary(null, CWD)
      expect(offered.kind).toBe('augmented')
      expect(offered.content).toContain('hand-written')
      expect(offered.content).not.toContain('banked')
    })

    it('ignores a hand-written handoff for a different repo', async () => {
      const j = await importFresh(tempDir)
      writeUserHandoff(tempDir, '/home/user/somewhere-else', 'other repo', Date.now() + 60_000)
      mkdirSync(j.journalDir(CWD), { recursive: true })
      writeFileSync(j.journalPath(CWD), '# Session journal\n\n**Branch**: main\n')

      const offered = j.offerSummary(null, CWD)
      expect(offered.kind).toBe('mechanical')
    })
  })

  describe('findUserHandoff', () => {
    it('matches on the Repo header, not the filename', async () => {
      const j = await importFresh(tempDir)
      writeUserHandoff(tempDir, CWD, 'the right one', Date.now())
      expect(j.findUserHandoff(CWD)?.content).toContain('the right one')
    })

    it('takes the newest of several for the same repo', async () => {
      const j = await importFresh(tempDir)
      writeUserHandoff(tempDir, CWD, 'older', Date.now() - 60_000, 'a')
      writeUserHandoff(tempDir, CWD, 'newer', Date.now(), 'b')
      expect(j.findUserHandoff(CWD)?.content).toContain('newer')
    })

    it('ignores handoffs past the age limit', async () => {
      const j = await importFresh(tempDir)
      const longAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
      writeUserHandoff(tempDir, CWD, 'ancient', longAgo)
      expect(j.findUserHandoff(CWD)).toBeNull()
    })
  })

  describe('assembleHandoff', () => {
    it('falls back to the stored journal when the facts script cannot run', async () => {
      const j = await importFresh(tempDir)
      j.capturePendingHandoff(CWD, 80, `## Mission\n${'x'.repeat(200)}\n${j.BANK_MARKER}`)
      mkdirSync(j.journalDir(CWD), { recursive: true })
      writeFileSync(j.journalPath(CWD), '**Branch**: main')

      const assembled = j.assembleHandoff(null, CWD)
      expect(assembled).toContain('## Mission')
    })

    it('returns nothing when no judgement has been banked', async () => {
      const j = await importFresh(tempDir)
      mkdirSync(j.journalDir(CWD), { recursive: true })
      writeFileSync(j.journalPath(CWD), '**Branch**: main')
      expect(j.assembleHandoff(null, CWD)).toBeNull()
    })
  })

  describe('judgement provenance', () => {
    const judgement = (j: { BANK_MARKER: string }, body: string) =>
      `## Mission\n${body}\n${'x'.repeat(200)}\n${j.BANK_MARKER}`

    it('records which source the judgement came from', async () => {
      const j = await importFresh(tempDir)
      j.capturePendingHandoff(CWD, 80, judgement(j, 'from compaction'), 'compaction')
      expect(readFileSync(j.pendingHandoffPath(CWD), 'utf-8')).toContain(
        'judgement source: compaction'
      )
    })

    it('defaults to the deliberately banked source', async () => {
      const j = await importFresh(tempDir)
      j.capturePendingHandoff(CWD, 80, judgement(j, 'banked'))
      expect(readFileSync(j.pendingHandoffPath(CWD), 'utf-8')).toContain(
        'judgement source: banked'
      )
    })

    it('stops the Stop hook paying for a turn once compaction has banked one', async () => {
      const j = await importFresh(tempDir)
      // Compaction judgement is free, so it pre-empts the paid bank entirely.
      j.capturePendingHandoff(CWD, 80, judgement(j, 'from compaction'), 'compaction')

      const path = transcriptWith(['2026-09-08T10:00:00Z'], tempDir)
      const now = Date.parse('2026-09-08T10:10:00Z')
      expect(
        j.shouldBankHandoff(j.readJournalState(CWD), 200, 9.0, 61, 1.5, path, now)
      ).toBe(false)
    })
  })

  describe('promoteIfUsed', () => {
    const bank = async (tempDir: string) => {
      const j = await importFresh(tempDir)
      j.capturePendingHandoff(
        CWD,
        80,
        `## Mission\nWire the two modes together\n${'x'.repeat(200)}\n${j.BANK_MARKER}`
      )
      return j
    }

    it('promotes a banked handoff into the user directory', async () => {
      const j = await bank(tempDir)
      const target = j.promoteIfUsed(null, CWD)

      expect(target).toContain(join(tempDir, '.claude', 'handoffs'))
      expect(readFileSync(target!, 'utf-8')).toContain('Wire the two modes together')
    })

    it('names the file from the mission line', async () => {
      const j = await bank(tempDir)
      expect(j.promoteIfUsed(null, CWD)).toContain('wire-the-two-modes-together')
    })

    it('removes the banked copy so only one document survives', async () => {
      const j = await bank(tempDir)
      j.promoteIfUsed(null, CWD)
      expect(existsSync(j.pendingHandoffPath(CWD))).toBe(false)
    })

    it('promotes only once, however often the project is resumed', async () => {
      const j = await bank(tempDir)
      expect(j.promoteIfUsed(null, CWD)).not.toBeNull()
      expect(j.promoteIfUsed(null, CWD)).toBeNull()
      expect(j.promoteIfUsed(null, CWD)).toBeNull()
    })

    it('does nothing when nothing was banked', async () => {
      const j = await importFresh(tempDir)
      expect(j.promoteIfUsed(null, CWD)).toBeNull()
    })

    it('leaves the promoted handoff findable for the same repo', async () => {
      const j = await bank(tempDir)
      j.promoteIfUsed(null, CWD)
      expect(j.findUserHandoff(CWD)?.content).toContain('Wire the two modes together')
    })
  })

  describe('the title line', () => {
    const withTitle = (j: { BANK_MARKER: string }, title: string) =>
      `# Handoff: ${title}\n\n## Mission\nSome prose that runs on.\n${'x'.repeat(200)}\n${j.BANK_MARKER}`

    it('names the promoted file', async () => {
      const j = await importFresh(tempDir)
      j.capturePendingHandoff(CWD, 80, withTitle(j, 'Wire clauditor into the handoff skill'))
      expect(j.promoteIfUsed(null, CWD)).toContain('wire-clauditor-into-the-handoff-skill')
    })

    it('is preferred over the first line of Mission', async () => {
      const j = await importFresh(tempDir)
      // The fallback would produce "some-prose-that-runs-on", which is the
      // failure the title line exists to prevent.
      j.capturePendingHandoff(CWD, 80, withTitle(j, 'Two mode summary'))
      const target = j.promoteIfUsed(null, CWD)
      expect(target).toContain('two-mode-summary')
      expect(target).not.toContain('some-prose')
    })

    it('sits above the header block in the assembled document', async () => {
      const j = await importFresh(tempDir)
      j.capturePendingHandoff(CWD, 80, withTitle(j, 'Two mode summary'))
      mkdirSync(j.journalDir(CWD), { recursive: true })
      writeFileSync(j.journalPath(CWD), '**Repo**: /home/user/project-a')

      const out = j.assembleHandoff(null, CWD)!
      expect(out.indexOf('# Handoff: Two mode summary')).toBeLessThan(out.indexOf('**Repo**'))
      // Exactly one copy, not one above the facts and one still inside the body.
      expect(out.match(/# Handoff:/g)).toHaveLength(1)
    })

    it('keeps the provenance comment at the top, not mid-document', async () => {
      const j = await importFresh(tempDir)
      j.capturePendingHandoff(CWD, 80, withTitle(j, 'Two mode summary'))
      mkdirSync(j.journalDir(CWD), { recursive: true })
      writeFileSync(j.journalPath(CWD), '**Repo**: /home/user/project-a')

      const out = j.assembleHandoff(null, CWD)!
      // Left where it was stored it lands between the header block and the
      // first section, reading as though a section had gone missing.
      expect(out.indexOf('judgement source')).toBeLessThan(out.indexOf('**Repo**'))
      expect(out).not.toMatch(/\n\n\n/)
      expect(out.match(/judgement source/g)).toHaveLength(1)
    })

    it('still produces a document when no title was written', async () => {
      const j = await importFresh(tempDir)
      j.capturePendingHandoff(CWD, 80, `## Mission\nNo title here.\n${'x'.repeat(200)}`)
      expect(j.assembleHandoff(null, CWD)).toContain('## Mission')
      expect(j.promoteIfUsed(null, CWD)).toContain('no-title-here')
    })
  })

  describe('bankInstruction', () => {
    it('asks only for the sections the facts script cannot produce', async () => {
      const { bankInstruction } = await importFresh(tempDir)
      const text = bankInstruction(250_000)

      expect(text).toContain('## Key decisions and why')
      expect(text).toContain('## Dead ends')
      expect(text).toContain('## Low confidence')
      // Asking for these would produce a second, staler copy of the facts.
      expect(text).not.toContain('## Files touched')
      expect(text).not.toContain('## Verification command')
      expect(text).not.toContain('## Required reading')
    })

    it('states the saving in terms of the context it protects', async () => {
      const { bankInstruction } = await importFresh(tempDir)
      const text = bankInstruction(250_000)
      expect(text).toContain('250,000')
      // The saving is the 1.9x spread between a warm read and a cold rewrite.
      expect(text).not.toContain('waste')
    })
  })
})
