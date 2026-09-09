import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

/**
 * End-to-end tests for banking, run against the built hook in a subprocess
 * with HOME redirected.
 *
 * These exist because the unit tests did not catch a bug that made the feature
 * completely inert. They fed `last_assistant_message` alongside
 * `stop_hook_active: false`, which cannot happen: a reply to a Stop-hook block
 * always arrives with the flag true. The test encoded the author's assumption
 * rather than the harness's behaviour, so it passed while the real path never
 * stored anything. Driving the actual hook is the only way to be honest about
 * which combinations occur.
 */

const HOOK = resolve(__dirname, '..', '..', 'dist', 'hooks', 'stop.js')
const CWD = '/home/user/project-a'

function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').slice(0, 100)
}

describe('Stop hook banking, end to end', () => {
  let home: string
  let transcript: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clauditor-bank-e2e-'))
    transcript = transcriptWithPeak(70, 400_000)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function runHook(input: Record<string, unknown>): string {
    return execFileSync('node', [HOOK], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      env: { ...process.env, HOME: home },
      timeout: 30_000,
    })
  }

  /** A transcript of `turns` assistant records whose peak context is `peak`. */
  function transcriptWithPeak(turns: number, peak: number, cwd: string = CWD): string {
    const path = join(home, `t-${turns}-${peak}-${encodeCwd(cwd)}.jsonl`)
    const now = new Date().toISOString()
    const recs: unknown[] = [{ type: 'user', cwd, timestamp: now }]
    for (let i = 0; i < turns; i++) {
      recs.push({
        type: 'assistant',
        timestamp: now,
        message: {
          model: 'claude-opus-5',
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: i < 10 ? 1000 : peak - 10,
          },
        },
      })
    }
    writeFileSync(path, recs.map((r) => JSON.stringify(r)).join('\n'))
    return path
  }

  const pendingPath = () =>
    join(home, '.clauditor', 'journals', encodeCwd(CWD), 'pending-handoff.md')

  it('asks for a handoff when the session has crossed break-even', () => {
    const out = runHook({
      session_id: 'e2e-0001',
      transcript_path: transcript,
      stop_hook_active: false,
      hook_event_name: 'Stop',
    })
    const decision = JSON.parse(out)
    expect(decision.decision).toBe('block')
    expect(decision.reason).toContain('cheapest moment')
  })

  it('stores the reply, which always arrives with stop_hook_active true', () => {
    // The regression. The reply to a block is re-entrant by definition, so a
    // capture that sits below the stop_hook_active guard never runs.
    runHook({
      session_id: 'e2e-0002',
      transcript_path: transcript,
      stop_hook_active: false,
      hook_event_name: 'Stop',
    })

    const body =
      `## Mission\nShip the thing.\n\n## Key decisions and why\n` +
      `- Bank warm. **Why**: cold costs 20x.\n${'x'.repeat(200)}\n` +
      `[clauditor-banked-handoff]`

    runHook({
      session_id: 'e2e-0002',
      transcript_path: transcript,
      stop_hook_active: true,
      hook_event_name: 'Stop',
      last_assistant_message: body,
    })

    expect(existsSync(pendingPath())).toBe(true)
    const stored = readFileSync(pendingPath(), 'utf-8')
    expect(stored).toContain('## Mission')
    expect(stored).toContain('judgement source: banked')
    expect(stored).not.toContain('[clauditor-banked-handoff]')
  })

  it('does not ask twice once the reply is stored', () => {
    const input = {
      session_id: 'e2e-0003',
      transcript_path: transcript,
      stop_hook_active: false,
      hook_event_name: 'Stop',
    }
    runHook(input)
    runHook({
      ...input,
      stop_hook_active: true,
      last_assistant_message: `## Mission\nDone.\n${'x'.repeat(200)}\n[clauditor-banked-handoff]`,
    })

    expect(JSON.parse(runHook(input))).toEqual({})
  })

  it('banks again in a later session in the same project', () => {
    // The bank state file is keyed by project directory, so testing bankedAt
    // alone retired the feature permanently after its first use in a repo.
    const first = {
      session_id: 'e2e-first',
      transcript_path: transcript,
      stop_hook_active: false,
      hook_event_name: 'Stop',
    }
    runHook(first)
    runHook({
      ...first,
      stop_hook_active: true,
      last_assistant_message: `## Mission\nDone.\n${'x'.repeat(200)}\n[clauditor-banked-handoff]`,
    })
    expect(JSON.parse(runHook(first))).toEqual({})

    const out = runHook({ ...first, session_id: 'e2e-second' })
    expect(JSON.parse(out).decision).toBe('block')
  }, 30_000)

  it('does not bank twice when one session changes directory', () => {
    // Bank state lives under the encoded cwd, and the cwd comes from the
    // transcript, so a session that moves repo reads a state file that has
    // never seen it and pays for a second handoff describing the same work.
    const first = {
      session_id: 'e2e-wanderer',
      transcript_path: transcript,
      stop_hook_active: false,
      hook_event_name: 'Stop',
    }
    runHook(first)
    runHook({
      ...first,
      stop_hook_active: true,
      last_assistant_message: `## Mission\nDone.\n${'x'.repeat(200)}\n[clauditor-banked-handoff]`,
    })

    const elsewhere = transcriptWithPeak(70, 400_000, '/home/user/project-b')
    expect(JSON.parse(runHook({ ...first, transcript_path: elsewhere }))).toEqual({})
  }, 30_000)

  it('never blocks on a re-entrant invocation', () => {
    // Blocking here is what produces an interruption loop.
    const out = runHook({
      session_id: 'e2e-0004',
      transcript_path: transcript,
      stop_hook_active: true,
      hook_event_name: 'Stop',
    })
    expect(JSON.parse(out)).toEqual({})
  })

  it('does not ask on a long session that never got large', () => {
    // The waste-factor gate banked this one: waste is last-five-turn cost over
    // first-five, so a busy short-context session scores high while there is
    // almost nothing for a cold rewrite to have to pay for.
    const out = runHook({
      session_id: 'e2e-0010',
      transcript_path: transcriptWithPeak(300, 40_000),
      stop_hook_active: false,
      hook_event_name: 'Stop',
    })
    expect(JSON.parse(out)).toEqual({})
  })

  it('asks on a short session that is already large', () => {
    // The mirror case the waste-factor gate missed: few turns, but a cold
    // rewrite of this context is exactly what banking avoids.
    const out = runHook({
      session_id: 'e2e-0011',
      transcript_path: transcriptWithPeak(12, 260_000),
      stop_hook_active: false,
      hook_event_name: 'Stop',
    })
    expect(JSON.parse(out).decision).toBe('block')
  })

  it('names the peak context it is protecting', () => {
    const out = runHook({
      session_id: 'e2e-0012',
      transcript_path: transcriptWithPeak(40, 260_000),
      stop_hook_active: false,
      hook_event_name: 'Stop',
    })
    expect(JSON.parse(out).reason).toContain('260,000')
  })

  it('ignores an ordinary reply that carries no marker', () => {
    runHook({
      session_id: 'e2e-0005',
      transcript_path: transcript,
      stop_hook_active: true,
      hook_event_name: 'Stop',
      last_assistant_message: 'Here is the refactor you asked for. ' + 'y'.repeat(300),
    })
    expect(existsSync(pendingPath())).toBe(false)
  })
})
