import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, utimesSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

/** A transcript of arbitrary typed records, written in the order given. */
function transcriptOf(records: object[], dir: string): string {
  const path = join(dir, 'typed-transcript.jsonl')
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n'))
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

/**
 * A stand-in facts script that reports only the session id it was handed.
 *
 * The real one is owned by the /handoff skill and reads a transcript; what
 * matters here is which id assembly passes it.
 */
function fakeFactsScript(home: string): void {
  const dir = join(home, '.claude', 'skills', 'handoff', 'scripts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'handoff-facts.py'),
    [
      'import sys',
      'sid = sys.argv[sys.argv.index("--session-id") + 1] if "--session-id" in sys.argv else "none"',
      'print("**Session**: " + sid)',
      '',
    ].join('\n')
  )
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

    it('ignores bookkeeping written after the last real turn', async () => {
      const { msSinceLastTurn } = await importFresh(tempDir)
      // Claude Code keeps writing timestamped records after the turn ends:
      // stop_hook_summary and turn_duration immediately, then away_summary
      // about three minutes later, when the user walks away. Counting those
      // as turns makes the one event the watchdog exists to detect reset the
      // watchdog's own clock.
      const path = transcriptOf(
        [
          { type: 'assistant', timestamp: '2026-09-08T10:00:00Z' },
          { type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-09-08T10:00:01Z' },
          { type: 'system', subtype: 'turn_duration', timestamp: '2026-09-08T10:00:02Z' },
          { type: 'system', subtype: 'away_summary', timestamp: '2026-09-08T10:03:00Z' },
        ],
        tempDir
      )
      const now = Date.parse('2026-09-08T10:30:00Z')
      expect(msSinceLastTurn(path, now)).toBe(30 * 60 * 1000)
    })

    it('ignores every timestamped record that is not a turn', async () => {
      const { msSinceLastTurn } = await importFresh(tempDir)
      // Measured across live transcripts: attachment and queue-operation
      // carry timestamps too, and outnumber the system records. An allowlist
      // of user and assistant covers them all; a denylist would not.
      const path = transcriptOf(
        [
          { type: 'user', timestamp: '2026-09-08T10:00:00Z' },
          { type: 'attachment', timestamp: '2026-09-08T10:10:00Z' },
          { type: 'queue-operation', timestamp: '2026-09-08T10:15:00Z' },
          { type: 'file-history-delta', timestamp: '2026-09-08T10:20:00Z' },
          { type: 'system', subtype: 'local_command', timestamp: '2026-09-08T10:25:00Z' },
        ],
        tempDir
      )
      const now = Date.parse('2026-09-08T10:30:00Z')
      expect(msSinceLastTurn(path, now)).toBe(30 * 60 * 1000)
    })

    it('returns null when the transcript holds no real turn at all', async () => {
      const { msSinceLastTurn } = await importFresh(tempDir)
      const path = transcriptOf(
        [{ type: 'system', subtype: 'away_summary', timestamp: '2026-09-08T10:00:00Z' }],
        tempDir
      )
      expect(msSinceLastTurn(path, Date.parse('2026-09-08T10:30:00Z'))).toBeNull()
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
      const state = { lastWriteAt: 0, lastFingerprint: '', bankedAt: 0, bankedAtTurn: 0, bankedSession: '', promotedAt: 0 }
      expect(shouldWriteJournal(state, 'anything', 1000)).toBe(true)
    })

    it('writes when the session moved', async () => {
      const { shouldWriteJournal } = await importFresh(tempDir)
      const state = { lastWriteAt: 1000, lastFingerprint: 'a', bankedAt: 0, bankedAtTurn: 0, bankedSession: '', promotedAt: 0 }
      expect(shouldWriteJournal(state, 'b', 2000)).toBe(true)
    })

    it('skips when nothing changed and the journal is fresh', async () => {
      const { shouldWriteJournal } = await importFresh(tempDir)
      const state = { lastWriteAt: 1000, lastFingerprint: 'a', bankedAt: 0, bankedAtTurn: 0, bankedSession: '', promotedAt: 0 }
      expect(shouldWriteJournal(state, 'a', 1000 + 60_000)).toBe(false)
    })

    it('writes anyway once the staleness cap is passed', async () => {
      const { shouldWriteJournal } = await importFresh(tempDir)
      // Standing in for "before the cache expires", which cannot be predicted:
      // a cache dies during idleness, when no hook fires.
      const state = { lastWriteAt: 1000, lastFingerprint: 'a', bankedAt: 0, bankedAtTurn: 0, bankedSession: '', promotedAt: 0 }
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
    const fresh = { lastWriteAt: 0, lastFingerprint: '', bankedAt: 0, bankedAtTurn: 0, bankedSession: '', promotedAt: 0 }
    const warm = Date.parse('2026-09-08T10:10:00Z')

    it('banks once peak context reaches the threshold and the cache is warm', async () => {
      const { shouldBankHandoff } = await importFresh(tempDir)
      const path = transcriptWith(['2026-09-08T10:00:00Z'], tempDir)
      expect(shouldBankHandoff(fresh, 200_000, 200_000, path, 's1', { now: warm })).toBe(true)
    })

    it('does not bank below the threshold', async () => {
      const { shouldBankHandoff } = await importFresh(tempDir)
      // Measured over 1,476 sessions: below ~200k the fixed cost of writing
      // the document outruns the 1.9x saved on the context it avoids
      // rewriting, so banking every such session loses tokens overall.
      const path = transcriptWith(['2026-09-08T10:00:00Z'], tempDir)
      expect(shouldBankHandoff(fresh, 199_999, 200_000, path, 's1', { now: warm })).toBe(false)
    })

    it('banks a short session that is already huge', async () => {
      const { shouldBankHandoff } = await importFresh(tempDir)
      // Turn count is not the gate. What a cold rewrite would cost depends on
      // context size alone, and a few enormous file reads get there fast.
      const path = transcriptWith(['2026-09-08T10:00:00Z'], tempDir)
      expect(shouldBankHandoff(fresh, 400_000, 200_000, path, 's1', { now: warm })).toBe(true)
    })

    it('never banks twice in a session', async () => {
      const { shouldBankHandoff } = await importFresh(tempDir)
      const path = transcriptWith(['2026-09-08T10:00:00Z'], tempDir)
      const banked = { ...fresh, bankedAt: 123, bankedAtTurn: 70, bankedSession: 's1' }
      expect(shouldBankHandoff(banked, 400_000, 200_000, path, 's1', { now: warm })).toBe(false)
    })

    it('does not bank once the cache is cold', async () => {
      const { shouldBankHandoff } = await importFresh(tempDir)
      // The whole point of banking early: cold, the same document costs 2x on
      // the context instead of 0.1x, and there is nothing left to save.
      const path = transcriptWith(['2026-09-08T10:00:00Z'], tempDir)
      const cold = Date.parse('2026-09-08T11:30:00Z')
      expect(shouldBankHandoff(fresh, 400_000, 200_000, path, 's1', { now: cold })).toBe(false)
    })
  })

  describe('an unanswered bank request', () => {
    const warm = Date.parse('2026-09-08T10:10:00Z')

    it('does not ask again at the same size', async () => {
      const j = await importFresh(tempDir)
      const path = transcriptWith(['2026-09-08T10:00:00Z'], tempDir)
      // The user interrupted the request, so nothing was banked. Asking again
      // at every stop for the rest of the session is worse than not asking.
      j.recordBankRequest(CWD, Date.now(), 235_852, 's1')

      expect(
        j.shouldBankHandoff(
          j.readJournalState(CWD), 240_000, 200_000, path, 's1',
          { now: warm, reBankGrowth: 100_000 }
        )
      ).toBe(false)
    })

    it('asks once more when the session has grown a long way since', async () => {
      const j = await importFresh(tempDir)
      const path = transcriptWith(['2026-09-08T10:00:00Z'], tempDir)
      j.recordBankRequest(CWD, Date.now(), 235_852, 's1')

      expect(
        j.shouldBankHandoff(
          j.readJournalState(CWD), 336_000, 200_000, path, 's1',
          { now: warm, reBankGrowth: 100_000 }
        )
      ).toBe(true)
    })
  })

  describe('a request left unanswered by another session', () => {
    it('does not silence this session\'s bank', async () => {
      const j = await importFresh(tempDir)
      const path = transcriptWith(['2026-09-08T10:00:00Z'], tempDir)
      // The state file is per directory, so the previous session's abandoned
      // request sits in the same file this session reads.
      j.recordBankRequest(CWD, Date.now(), 235_852, 'previous-session')

      expect(
        j.shouldBankHandoff(
          j.readJournalState(CWD), 240_000, 200_000, path, 'this-session',
          { now: Date.parse('2026-09-08T10:10:00Z'), reBankGrowth: 100_000 }
        )
      ).toBe(true)
    })
  })

  describe('shouldBankHandoff, across sessions', () => {
    const warm = Date.parse('2026-09-08T10:10:00Z')

    it('banks again in a later session in the same project', async () => {
      const j = await importFresh(tempDir)
      const path = transcriptWith(['2026-09-08T10:00:00Z'], tempDir)
      // Bank state lives per project directory, so keying "already banked" on
      // the directory alone retires the feature after one use for good.
      const banked = {
        lastWriteAt: 0, lastFingerprint: '', bankedAt: 123,
        bankedAtTurn: 70, bankedSession: 'session-one', promotedAt: 0,
      }
      expect(
        j.shouldBankHandoff(banked, 400_000, 200_000, path, 'session-two', { now: warm })
      ).toBe(true)
    })

    it('refuses a second bank after the session changes directory', async () => {
      const j = await importFresh(tempDir)
      const path = transcriptWith(['2026-09-08T10:00:00Z'], tempDir)
      // The bank happens in one repo; the session then moves to another, whose
      // state file has never seen it. Without a session-keyed ledger the same
      // session pays for a second handoff describing the same work.
      j.capturePendingHandoff(CWD, 80, `## Mission\n${'x'.repeat(200)}\n${j.BANK_MARKER}`, {
        sessionId: 'wanderer',
      })

      const elsewhere = j.readJournalState('/home/user/project-b')
      expect(elsewhere.bankedAt).toBe(0)
      expect(
        j.shouldBankHandoff(elsewhere, 400_000, 200_000, path, 'wanderer', { now: warm })
      ).toBe(false)
    })

    it('leaves a free compaction bank out of the ledger, so a new repo still gets one', async () => {
      const j = await importFresh(tempDir)
      const path = transcriptWith(['2026-09-08T10:00:00Z'], tempDir)
      // Compaction judgement costs no turn, so there is no spend to protect,
      // and recording it would leave the repo moved into with nothing banked.
      j.capturePendingHandoff(CWD, 80, `## Mission\n${'x'.repeat(200)}\n${j.BANK_MARKER}`, {
        sessionId: 'wanderer',
        source: 'compaction',
      })

      expect(j.hasSessionBanked('wanderer')).toBe(false)
      expect(
        j.shouldBankHandoff(
          j.readJournalState('/home/user/project-b'),
          400_000, 200_000, path, 'wanderer', { now: warm }
        )
      ).toBe(true)
    })

    it('still refuses a second bank inside the same session', async () => {
      const j = await importFresh(tempDir)
      const path = transcriptWith(['2026-09-08T10:00:00Z'], tempDir)
      const banked = {
        lastWriteAt: 0, lastFingerprint: '', bankedAt: 123,
        bankedAtTurn: 70, bankedSession: 'session-one', promotedAt: 0,
      }
      expect(
        j.shouldBankHandoff(banked, 400_000, 200_000, path, 'session-one', { now: warm })
      ).toBe(false)
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

    it('records the document it produced and the peak it banked at', async () => {
      const j = await importFresh(tempDir)
      // The fallback route writes the judgement to clauditor's own pending
      // path, and that file is the one a re-bank has to overwrite. A marker
      // with an empty path sends the next bank off to write a second document,
      // and the prompt the user already pasted then names the staler of the two.
      j.capturePendingHandoff(CWD, 80, `## Mission\n${'x'.repeat(200)}\n${j.BANK_MARKER}`, {
        sessionId: 'fallback-session',
        peakContext: 143_000,
      })

      const bank = j.readSessionBank('fallback-session')
      expect(bank?.handoffPath).toBe(j.pendingHandoffPath(CWD))
      expect(bank?.peakContext).toBe(143_000)
    })

    it('rejects a reply too short to be a handoff', async () => {
      const j = await importFresh(tempDir)
      expect(j.capturePendingHandoff(CWD, 80, `ok ${j.BANK_MARKER}`)).toBe(false)
      expect(existsSync(j.pendingHandoffPath(CWD))).toBe(false)
    })
  })

  describe('the guard against a re-bank it was asked for', () => {
    const banked = (j: typeof import('./journal.js'), now = Date.now()) =>
      j.markSessionBanked('rebanker', CWD, now, {
        peakContext: 210_000,
        handoffPath: '/h/first.md',
      })

    it('lets the session write the handoff it has just been asked for', async () => {
      const j = await importFresh(tempDir)
      // The Stop hook asks for a re-bank and names the file to overwrite. The
      // guard refusing Write makes that request unanswerable, and the session
      // falls back to reciting the whole document into the terminal.
      banked(j)
      j.markBankRequested('rebanker', Date.now() + 1000)

      expect(j.isBlockedAfterBank('rebanker', 'Write')).toBe(false)
      expect(j.isBlockedAfterBank('rebanker', 'Edit')).toBe(false)
    })

    it('still refuses a new agent, which no request ever needs', async () => {
      const j = await importFresh(tempDir)
      banked(j)
      j.markBankRequested('rebanker', Date.now() + 1000)

      expect(j.isBlockedAfterBank('rebanker', 'Task')).toBe(true)
    })

    it('closes again once the re-bank has been captured', async () => {
      const j = await importFresh(tempDir)
      banked(j)
      j.markBankRequested('rebanker', Date.now() + 1000)
      // The answer arrives and is banked, which supersedes the request.
      j.markSessionBanked('rebanker', CWD, Date.now() + 2000, {
        peakContext: 320_000,
        handoffPath: '/h/first.md',
      })

      expect(j.isBlockedAfterBank('rebanker', 'Write')).toBe(true)
    })

    it('ignores a request older than the bank that answered it', async () => {
      const j = await importFresh(tempDir)
      j.markBankRequested('rebanker', 1000)
      banked(j, 2000)

      expect(j.isBlockedAfterBank('rebanker', 'Write')).toBe(true)
    })
  })

  describe('an unattended bank', () => {
    it('leaves the session able to keep working', async () => {
      const j = await importFresh(tempDir)
      // The user never asked for this bank. Returning to a session that refuses
      // edits until you find the continue phrase is a trap.
      j.markSessionBanked('woken', CWD, Date.now(), {
        peakContext: 120_000,
        handoffPath: '/h/woken.md',
        continueAfterBank: true,
      })
      expect(j.isBlockedAfterBank('woken', 'Edit')).toBe(false)
      expect(j.readSessionBank('woken')?.handoffPath).toBe('/h/woken.md')
    })

    it('still blocks after a bank the user asked for', async () => {
      const j = await importFresh(tempDir)
      j.markSessionBanked('asked', CWD, Date.now(), {
        peakContext: 120_000,
        handoffPath: '/h/asked.md',
      })
      expect(j.isBlockedAfterBank('asked', 'Edit')).toBe(true)
    })

    it('hands the flag to exactly one reader', async () => {
      const j = await importFresh(tempDir)
      j.markUnattendedBank(CWD, 'woken')
      expect(j.takeUnattendedBank(CWD, 'woken')).toBe(true)
      expect(j.takeUnattendedBank(CWD, 'woken')).toBe(false)
    })

    it('ignores a flag left by another session', async () => {
      const j = await importFresh(tempDir)
      j.markUnattendedBank(CWD, 'theirs')
      expect(j.takeUnattendedBank(CWD, 'mine')).toBe(false)
    })
  })

  describe('the journal state under two concurrent sessions', () => {
    it('applies an update to the state as it stands, not to a stale snapshot', async () => {
      const j = await importFresh(tempDir)
      // Observed live on 2026-09-10: two sessions banking in one directory left
      // its state.json with bankedSession naming one, bankedAtPeak holding the
      // other's peak, and promotedAt reset to 0. Each had read the state, then
      // written its own whole object back over the other's fields.
      const stale = j.readJournalState(CWD)

      // The other session banks while this one is holding that snapshot.
      j.writeJournalState(CWD, { ...stale, bankedSession: 'session-b', bankedAtPeak: 512_000 })

      // This session now finishes the update it began from the stale snapshot.
      j.updateJournalState(CWD, (state) => ({ ...state, promotedPath: '/a.md', promotedAt: 5 }))

      const after = j.readJournalState(CWD)
      expect(after.promotedPath).toBe('/a.md')
      expect(after.promotedAt).toBe(5)
      expect(after.bankedSession).toBe('session-b')
      expect(after.bankedAtPeak).toBe(512_000)
    })

    it('writes anyway when a lock is left behind by a session that died', async () => {
      const j = await importFresh(tempDir)
      mkdirSync(j.journalDir(CWD), { recursive: true })
      const lock = join(j.journalDir(CWD), 'state.json.lock')
      writeFileSync(lock, 'held')
      const old = Date.now() / 1000 - 3600
      utimesSync(lock, old, old)

      j.updateJournalState(CWD, (state) => ({ ...state, bankedAtTurn: 42 }))

      expect(j.readJournalState(CWD).bankedAtTurn).toBe(42)
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

  describe('adoptBankedHandoff', () => {
    const judgement = `# Handoff: Written to disk\n\n## Mission\n${'x'.repeat(200)}\n`
    const handoffs = (home: string) => join(home, '.claude', 'handoffs')

    /** Stand in for the model's own Write call, wherever it put the file. */
    const modelWrites = (path: string, text = judgement) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
      return path
    }

    it('keeps the file the reply names, so the pasted prompt resolves', async () => {
      const j = await importFresh(tempDir)
      j.recordBankRequest(CWD)
      const written = modelWrites(join(handoffs(tempDir), 'written-to-disk-20260909-1400.md'))

      const adopted = j.adoptBankedHandoff(CWD, 80, {
        sessionId: 's1',
        peakContext: 260_000,
        reply: `Continue a paused task. Read \`${written}\` in full before doing anything else.`,
      })
      expect(adopted).toBe(written)
      expect(readFileSync(written, 'utf-8')).toContain('## Mission')
    })

    it('gives the banked document the mechanical half at once', async () => {
      const j = await importFresh(tempDir)
      // Without facts the pasted prompt cannot ask for a verification command.
      const repo = join(tempDir, 'repo')
      mkdirSync(repo, { recursive: true })
      fakeFactsScript(tempDir)
      j.recordBankRequest(repo)
      const written = modelWrites(join(handoffs(tempDir), 'written-to-disk-20260909-1400.md'))

      j.adoptBankedHandoff(repo, 80, { sessionId: 'banked-session', reply: written })
      expect(readFileSync(written, 'utf-8')).toContain('**Session**: banked-session')
    })

    it('names the banking session, not the one the state still remembers', async () => {
      const j = await importFresh(tempDir)
      const repo = join(tempDir, 'repo')
      mkdirSync(repo, { recursive: true })
      fakeFactsScript(tempDir)

      // A previous session banked in this repo, so the state names it.
      j.recordBankRequest(repo)
      modelWrites(join(handoffs(tempDir), 'earlier-20260909-1200.md'))
      j.adoptBankedHandoff(repo, 40, { sessionId: 'previous-session' })
      expect(j.readJournalState(repo).bankedSession).toBe('previous-session')

      // Now this session banks. Preferring the stored id here gave the new
      // document the previous session's files, reads and commits.
      j.recordBankRequest(repo)
      const mine = modelWrites(join(handoffs(tempDir), 'mine-20260909-1600.md'))
      const adopted = j.adoptBankedHandoff(repo, 80, { sessionId: 'this-session' })

      const stored = readFileSync(adopted ?? mine, 'utf-8')
      expect(stored).toContain('**Session**: this-session')
      expect(stored).not.toContain('previous-session')
    })

    it('declines a bank request another session made', async () => {
      const j = await importFresh(tempDir)
      // The state can carry a request this session never answered: a previous
      // session's request in the same repo, or one the user interrupted.
      j.recordBankRequest(CWD, Date.now(), 0, 'other-session')
      const theirs = modelWrites(join(handoffs(tempDir), 'theirs-20260910-0918.md'))

      expect(j.adoptBankedHandoff(CWD, 80, { sessionId: 'mine' })).toBeNull()
      expect(readFileSync(theirs, 'utf-8')).toBe(judgement)
    })

    it('never adopts a document another session banked', async () => {
      const j = await importFresh(tempDir)
      fakeFactsScript(tempDir)
      j.recordBankRequest(CWD, Date.now(), 0, 'mine')
      // The handoffs directory is shared by every repo, so the newest file in
      // it since the request can belong to a different session entirely.
      const theirs = modelWrites(
        join(handoffs(tempDir), 'theirs-20260910-0918.md'),
        `# Handoff: Theirs\n\n**Repo**: /home/user/project-b\n**Session**: their-session\n\n## Mission\n${'x'.repeat(200)}\n`
      )

      expect(j.adoptBankedHandoff(CWD, 80, { sessionId: 'mine' })).toBeNull()
      const left = readFileSync(theirs, 'utf-8')
      expect(left).toContain('**Session**: their-session')
      expect(left).not.toContain('mine')
    })

    it('does not re-bank over a promotedPath that now names another session', async () => {
      const j = await importFresh(tempDir)
      fakeFactsScript(tempDir)
      // A state can point at a document that is not this session's, whether
      // from an earlier defect or a file the user moved. Reusing it verbatim
      // would overwrite that session's handoff on every later re-bank.
      const theirs = modelWrites(
        join(handoffs(tempDir), 'theirs-20260910-0918.md'),
        `# Handoff: Theirs\n\n**Repo**: /home/user/project-b\n**Session**: their-session\n\n## Mission\n${'x'.repeat(200)}\n`
      )
      j.recordBankRequest(CWD, Date.now(), 0, 'mine')
      j.writeJournalState(CWD, { ...j.readJournalState(CWD), promotedPath: theirs })
      const mine = modelWrites(join(handoffs(tempDir), 'mine-20260910-0925.md'))

      const adopted = j.adoptBankedHandoff(CWD, 80, { sessionId: 'mine' })
      expect(adopted).toBe(mine)
      expect(readFileSync(theirs, 'utf-8')).toContain('**Session**: their-session')
    })

    it('finds the file even when the reply names no path', async () => {
      const j = await importFresh(tempDir)
      j.recordBankRequest(CWD)
      const written = modelWrites(join(handoffs(tempDir), 'anything-20260909-1400.md'))
      expect(j.adoptBankedHandoff(CWD, 80, { sessionId: 's1' })).toBe(written)
    })

    it('adopts from the clauditor path a stray model may have used', async () => {
      const j = await importFresh(tempDir)
      j.recordBankRequest(CWD)
      modelWrites(j.pendingHandoffPath(CWD))

      const adopted = j.adoptBankedHandoff(CWD, 80, { sessionId: 's1' })
      expect(adopted).toContain(handoffs(tempDir))
      // One document, not one in each place.
      expect(existsSync(j.pendingHandoffPath(CWD))).toBe(false)
    })

    it('records the peak and the path, so a re-bank can replace it', async () => {
      const j = await importFresh(tempDir)
      j.recordBankRequest(CWD)
      const written = modelWrites(join(handoffs(tempDir), 'thing-20260909-1400.md'))
      j.adoptBankedHandoff(CWD, 80, { sessionId: 's1', peakContext: 260_000 })

      expect(j.readJournalState(CWD).promotedPath).toBe(written)
      expect(j.readSessionBank('s1')).toMatchObject({
        peakContext: 260_000,
        handoffPath: written,
      })
    })

    it('a re-bank overwrites the first file rather than adding another', async () => {
      const j = await importFresh(tempDir)
      j.recordBankRequest(CWD)
      const first = modelWrites(join(handoffs(tempDir), 'thing-20260909-1400.md'))
      j.adoptBankedHandoff(CWD, 80, { sessionId: 's1', peakContext: 260_000 })

      // The model, asked again later, writes somewhere new anyway.
      j.recordBankRequest(CWD)
      modelWrites(
        join(handoffs(tempDir), 'thing-20260909-1500.md'),
        `# Handoff: Written to disk\n\n## Mission\nlater state\n${'x'.repeat(200)}\n`
      )
      const adopted = j.adoptBankedHandoff(CWD, 90, { sessionId: 's1', peakContext: 380_000 })

      expect(adopted).toBe(first)
      expect(readFileSync(first, 'utf-8')).toContain('later state')
      expect(existsSync(join(handoffs(tempDir), 'thing-20260909-1500.md'))).toBe(false)
    })

    it('refuses a file left over from an earlier bank', async () => {
      const j = await importFresh(tempDir)
      const stale = modelWrites(join(handoffs(tempDir), 'old-20260901-0900.md'))
      const longAgo = Date.now() - 60 * 60 * 1000
      utimesSync(stale, longAgo / 1000, longAgo / 1000)
      j.recordBankRequest(CWD)

      expect(j.adoptBankedHandoff(CWD, 80, { sessionId: 's1' })).toBeNull()
    })

    it('refuses when no bank was ever asked for', async () => {
      const j = await importFresh(tempDir)
      modelWrites(join(handoffs(tempDir), 'unasked-20260909-1400.md'))
      expect(j.adoptBankedHandoff(CWD, 80, { sessionId: 's1' })).toBeNull()
    })

    it('refuses when the model answered in the reply instead', async () => {
      const j = await importFresh(tempDir)
      j.recordBankRequest(CWD)
      // Nothing written: the caller has to fall back to the message.
      expect(j.adoptBankedHandoff(CWD, 80, { sessionId: 's1' })).toBeNull()
    })

    it('strips the marker if the model put it in the file', async () => {
      const j = await importFresh(tempDir)
      j.recordBankRequest(CWD)
      const written = modelWrites(
        join(handoffs(tempDir), 'thing-20260909-1400.md'),
        `${judgement}\n${j.BANK_MARKER}\n`
      )
      j.adoptBankedHandoff(CWD, 80, { sessionId: 's1' })
      expect(readFileSync(written, 'utf-8')).not.toContain(j.BANK_MARKER)
    })

    it('keeps one provenance line however often a file is adopted', async () => {
      const j = await importFresh(tempDir)
      j.recordBankRequest(CWD)
      const written = modelWrites(join(handoffs(tempDir), 'thing-20260909-1400.md'))
      j.adoptBankedHandoff(CWD, 80, { sessionId: 's1' })
      j.recordBankRequest(CWD)
      j.adoptBankedHandoff(CWD, 90, { sessionId: 's1' })

      expect(readFileSync(written, 'utf-8').match(/judgement source:/g)).toHaveLength(1)
    })
  })

  describe('bankInstruction', () => {
    it('sends the handoff to the user\'s own directory, named from the title', async () => {
      const j = await importFresh(tempDir)
      const text = j.bankInstruction(260_000, { stamp: '20260909-1400' })
      expect(text).toContain(join(tempDir, '.claude', 'handoffs'))
      expect(text).toContain('<slug>-20260909-1400.md')
      expect(text).toContain('Write tool')
    })

    it('asks for the paste prompt as the whole reply', async () => {
      const j = await importFresh(tempDir)
      const text = j.bankInstruction(260_000, { stamp: '20260909-1400' })
      expect(text).toContain('Continue a paused task. Read `<path>` in full')
      expect(text).toContain('do not repeat any of its content in your reply')
    })

    it('sends a re-bank at the file the first bank produced', async () => {
      const j = await importFresh(tempDir)
      // The user may have pasted that path already, so it has to stay put.
      const text = j.bankInstruction(360_000, {
        stamp: '20260909-1500',
        rewritePath: '/home/user/.claude/handoffs/thing-20260909-1400.md',
      })
      expect(text).toContain('Overwrite this file')
      expect(text).toContain('thing-20260909-1400.md')
      expect(text).not.toContain('<slug>')
    })

    it('asks for in-flight agents to be recorded and left alone', async () => {
      const j = await importFresh(tempDir)
      const text = j.bankInstruction(260_000, { stamp: '20260909-1400' })
      expect(text).toContain('## In-flight agents')
      expect(text).toContain('do not stop them')
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

    it('regenerates the facts under the session that banked, not the one assembling', async () => {
      const j = await importFresh(tempDir)
      // The facts script runs in the repo, so the repo has to exist.
      const repo = join(tempDir, 'repo')
      mkdirSync(repo, { recursive: true })
      fakeFactsScript(tempDir)
      j.capturePendingHandoff(repo, 80, `## Mission\n${'x'.repeat(200)}\n${j.BANK_MARKER}`, {
        sessionId: 'banked-session',
      })

      // A later session promotes it, and must not put its own name on the work.
      const assembled = j.assembleHandoff('promoting-session', repo)!
      expect(assembled).toContain('**Session**: banked-session')
      expect(assembled).not.toContain('promoting-session')
    })

    it('falls back to the assembling session for state banked before the id was recorded', async () => {
      const j = await importFresh(tempDir)
      const repo = join(tempDir, 'repo')
      mkdirSync(repo, { recursive: true })
      fakeFactsScript(tempDir)
      j.capturePendingHandoff(repo, 80, `## Mission\n${'x'.repeat(200)}\n${j.BANK_MARKER}`)

      expect(j.assembleHandoff('only-id-available', repo)).toContain(
        '**Session**: only-id-available'
      )
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
      j.capturePendingHandoff(CWD, 80, judgement(j, 'from compaction'), { source: 'compaction' })
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
      j.capturePendingHandoff(CWD, 80, judgement(j, 'from compaction'), {
        sessionId: 's1',
        source: 'compaction',
      })

      const path = transcriptWith(['2026-09-08T10:00:00Z'], tempDir)
      const now = Date.parse('2026-09-08T10:10:00Z')
      expect(
        j.shouldBankHandoff(
          j.readJournalState(CWD), 400_000, 200_000, path, 's1', { now: now }
        )
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
      const text = bankInstruction(250_000, { stamp: '20260909-1400' })

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
      const text = bankInstruction(250_000, { stamp: '20260909-1400' })
      expect(text).toContain('250,000')
      // The saving is the 1.9x spread between a warm read and a cold rewrite.
      expect(text).not.toContain('waste')
    })
  })
})

describe('winding down after a bank', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-winddown-'))
  })

  afterEach(() => {
    vi.doUnmock('node:os')
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('allows every tool while the session has not banked', async () => {
    const { isBlockedAfterBank } = await importFresh(tempDir)
    for (const tool of ['Task', 'Edit', 'Write', 'Bash', 'Read']) {
      expect(isBlockedAfterBank('s-1', tool)).toBe(false)
    }
  })

  it('blocks a new agent once the session has banked', async () => {
    const { markSessionBanked, isBlockedAfterBank } = await importFresh(tempDir)
    markSessionBanked('s-1', CWD, Date.now(), { peakContext: 210_000 })
    expect(isBlockedAfterBank('s-1', 'Task')).toBe(true)
  })

  it('blocks the edits that would make the banked handoff stale', async () => {
    const { markSessionBanked, isBlockedAfterBank } = await importFresh(tempDir)
    markSessionBanked('s-1', CWD, Date.now(), { peakContext: 210_000 })
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      expect(isBlockedAfterBank('s-1', tool)).toBe(true)
    }
  })

  it('never blocks Bash, which is how the handoff itself gets updated', async () => {
    const { markSessionBanked, isBlockedAfterBank } = await importFresh(tempDir)
    markSessionBanked('s-1', CWD, Date.now(), { peakContext: 210_000 })
    // Stephen: "we won't block bash calls to update that (if needed)".
    expect(isBlockedAfterBank('s-1', 'Bash')).toBe(false)
    expect(isBlockedAfterBank('s-1', 'Read')).toBe(false)
  })

  it('blocks only the session that banked, not its neighbours', async () => {
    const { markSessionBanked, isBlockedAfterBank } = await importFresh(tempDir)
    markSessionBanked('s-1', CWD, Date.now(), { peakContext: 210_000 })
    expect(isBlockedAfterBank('s-2', 'Task')).toBe(false)
  })

  it('lifts the block once work after the bank is explicitly allowed', async () => {
    const { markSessionBanked, allowWorkAfterBank, isBlockedAfterBank } =
      await importFresh(tempDir)
    markSessionBanked('s-1', CWD, Date.now(), { peakContext: 210_000 })
    allowWorkAfterBank('s-1')
    for (const tool of ['Task', 'Edit', 'Write']) {
      expect(isBlockedAfterBank('s-1', tool)).toBe(false)
    }
  })

  it('keeps the bank itself intact when the block is lifted', async () => {
    const { markSessionBanked, allowWorkAfterBank, readSessionBank } =
      await importFresh(tempDir)
    markSessionBanked('s-1', CWD, Date.now(), {
      peakContext: 210_000,
      handoffPath: '/tmp/h.md',
    })
    allowWorkAfterBank('s-1')
    const bank = readSessionBank('s-1')
    // Losing these would let the session bank a second time for the same work.
    expect(bank?.peakContext).toBe(210_000)
    expect(bank?.handoffPath).toBe('/tmp/h.md')
  })

})
