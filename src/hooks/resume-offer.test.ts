import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { encodeCwd } from '../features/journal.js'

/**
 * The resume advisory is offered once, not to every session that opens the
 * repo for the next week.
 *
 * Driven through the built hook rather than the predicate, because the
 * predicate passing proves nothing about whether the hook is wired to it: a
 * unit-tested feature in this repo has already shipped inert once for exactly
 * that reason.
 *
 * Observed live on 2026-09-10: a handoff banked at 16:59 was still being
 * pitched to unrelated new sessions in the same repo the following day, and
 * would have gone on until findUserHandoff's seven-day window closed.
 */

const SESSION_START = resolve(__dirname, '..', '..', 'dist', 'hooks', 'session-start.js')

describe('offering a handoff to a new session, end to end', () => {
  let home: string
  let cwd: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clauditor-resume-offer-'))
    cwd = join(home, 'project-a')
    mkdirSync(cwd, { recursive: true })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  /** A handoff in the user's own directory, headed for this repo. */
  function writeHandoff(name: string): string {
    const dir = join(home, '.claude', 'handoffs')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, name)
    writeFileSync(
      path,
      `# Handoff: something earlier\n\n**Repo**: ${cwd}\n\n## Mission\n` +
        `Work that a later session might want to pick up, long enough to clear ` +
        `the minimum body length that offerSummary requires of a document.\n`
    )
    return path
  }

  function start(sessionId: string): Record<string, unknown> {
    const out = execFileSync('node', [SESSION_START], {
      input: JSON.stringify({
        session_id: sessionId,
        hook_event_name: 'SessionStart',
        source: 'startup',
        cwd,
      }),
      encoding: 'utf-8',
      env: { ...process.env, HOME: home },
      timeout: 30_000,
    })
    return JSON.parse(out || '{}')
  }

  it('offers the handoff to the first new session', () => {
    const path = writeHandoff('earlier-work-20260910-1658.md')
    const out = start('session-one')
    expect(out.systemMessage).toContain(path)
  }, 30_000)

  it('does not offer the same handoff to the next session', () => {
    writeHandoff('earlier-work-20260910-1658.md')
    expect(start('session-one').systemMessage).toBeDefined()
    // The session that got the offer either took it or did not. Either way it
    // has been made, and repeating it to every later session is noise.
    expect(start('session-two').systemMessage).toBeUndefined()
  }, 30_000)

  /**
   * The full measured fixture: a bank marker the handoff pairs with, and a
   * transcript whose last turn sets the cache age.
   */
  function bankHandoff(path: string, lastTurnAgoMs: number): void {
    const session = 'banking-session'
    const banked = join(home, '.clauditor', 'banked')
    mkdirSync(banked, { recursive: true })
    writeFileSync(
      join(banked, `${session}.json`),
      JSON.stringify({
        bankedAt: Date.now(),
        cwd,
        peakContext: 250_000,
        handoffPath: path,
      })
    )

    const journals = join(home, '.clauditor', 'journals', encodeCwd(cwd))
    mkdirSync(journals, { recursive: true })
    writeFileSync(
      join(journals, 'state.json'),
      JSON.stringify({ bankedAt: Date.now(), bankedSession: session, promotedAt: Date.now() })
    )

    setCacheAge(lastTurnAgoMs)
  }

  /**
   * Age the banking session's last turn. Separate from bankHandoff, and
   * touching only the transcript: rewriting state.json here would wipe the
   * offeredPath this file exists to test, and did, silently passing a test
   * that could not fail.
   */
  function setCacheAge(lastTurnAgoMs: number): void {
    const projects = join(home, '.claude', 'projects', encodeCwd(cwd))
    mkdirSync(projects, { recursive: true })
    writeFileSync(
      join(projects, 'banking-session.jsonl'),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(Date.now() - lastTurnAgoMs).toISOString(),
        message: {
          model: 'claude-opus-5',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 249_999,
          },
        },
      })
    )
  }

  it('does not spend the offer on a session shown nothing', () => {
    // A warm cache produces no advisory, because resuming the conversation is
    // cheaper than the handoff. If that silence consumed the offer, the
    // handoff would never be advertised once the cache went cold.
    const path = writeHandoff('earlier-work-20260910-1658.md')
    bankHandoff(path, 5 * 60 * 1000)
    expect(start('session-one').systemMessage).toBeUndefined()

    setCacheAge(3 * 60 * 60 * 1000)
    expect(start('session-two').systemMessage).toContain(path)
  }, 30_000)

  it('offers a newer handoff, which is an offer of its own', () => {
    writeHandoff('earlier-work-20260910-1658.md')
    expect(start('session-one').systemMessage).toBeDefined()

    const newer = writeHandoff('later-work-20260911-1042.md')
    expect(start('session-two').systemMessage).toContain(newer)
  }, 30_000)
})
