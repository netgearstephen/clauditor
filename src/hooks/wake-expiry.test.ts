import { describe, it, expect, beforeEach, afterEach, inject } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { bankInstruction, WAKE_EXPIRED } from '../features/journal.js'

/**
 * An expired wake must be refused before the model ever sees it.
 *
 * 13 Oct: an idle bank was queued to a session's inbox at 18:29Z and held
 * there until 08:56Z the next morning. The deadline was in the text, so the
 * model read it, saw it had passed and spent nothing on the handoff, but
 * reading it was the cost: 87,475 tokens of cold cache write to say "wake
 * expired". UserPromptSubmit fires for an inbox message exactly as for a typed
 * prompt, and a block there ends it with no model call, which was measured on
 * a live session on 14 Oct.
 */

/** The prompt UserPromptSubmit receives for a wake delivered to the inbox. */
function wake(expiresAt: number): string {
  const body = bankInstruction(120_000, {
    stamp: '20261013-1929',
    now: expiresAt - 4 * 60 * 1000,
    expiresAt,
    herdr: false,
  })
  return [
    '<cross-session-message from="uds:/tmp/cc-socks/92537.sock" from-name="x" from-mode="bypass">',
    body,
    '</cross-session-message>',
  ].join('\n')
}

describe('UserPromptSubmit, end to end', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clauditor-wake-expiry-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function submit(prompt: string): Record<string, unknown> {
    const out = execFileSync(
      'node',
      [resolve(inject('distDir'), 'hooks', 'user-prompt-submit.js')],
      {
        input: JSON.stringify({
          session_id: 'wake-expiry',
          hook_event_name: 'UserPromptSubmit',
          cwd: home,
          prompt,
        }),
        encoding: 'utf-8',
        env: { ...process.env, HOME: home },
      }
    )
    return JSON.parse(out)
  }

  it('blocks a wake whose deadline has passed', () => {
    const out = submit(wake(Date.now() - 14 * 60 * 60 * 1000))
    expect(out.decision).toBe('block')
    expect(out.reason).toBe(WAKE_EXPIRED)
  })

  it('blocks a wake dequeued just inside its deadline', () => {
    // Too late to reach the API before the cache goes, so as good as expired.
    expect(submit(wake(Date.now() + 20 * 1000)).decision).toBe('block')
  })

  it('lets a wake through while its deadline is still ahead', () => {
    expect(submit(wake(Date.now() + 3 * 60 * 1000))).toEqual({})
  })

  it('never blocks a typed prompt that quotes an expired wake', () => {
    // Only the inbox wraps a prompt in cross-session-message, so a user
    // pasting the text to ask about it is not the wake itself.
    const body = wake(Date.now() - 60 * 60 * 1000).split('\n').slice(1, -1).join('\n')
    expect(submit(`what does this mean?\n\n${body}`)).toEqual({})
  })

  it('never blocks a cross-session message that is not a wake', () => {
    const prompt = [
      '<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="peer" from-mode="bypass">',
      'clauditor-wake-expires-at is a tag; can you check the 13 Oct one?',
      '</cross-session-message>',
    ].join('\n')
    expect(submit(prompt)).toEqual({})
  })

  it('never blocks an ordinary prompt', () => {
    expect(submit('carry on')).toEqual({})
  })
})
