import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
    // Three hook invocations at roughly 1.7s each outrun the 5s default.
  }, 30_000)

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

  it('asks for a file in the user\'s handoffs directory, and adopts what was written', () => {
    // The point of the file: what the user sees is a prompt they can paste,
    // not the whole document recited back at them.
    const request = {
      session_id: 'e2e-written',
      transcript_path: transcript,
      stop_hook_active: false,
      hook_event_name: 'Stop',
    }
    const reason = JSON.parse(runHook(request)).reason as string
    expect(reason).toContain(join(home, '.claude', 'handoffs'))
    expect(reason).toContain('Continue a paused task. Read `<path>` in full')

    // Stand in for the model's Write call on the blocked turn.
    const written = join(home, '.claude', 'handoffs', 'ship-the-thing-20260909-1400.md')
    mkdirSync(dirname(written), { recursive: true })
    writeFileSync(
      written,
      `# Handoff: Ship the thing\n\n## Mission\nShip the thing.\n${'x'.repeat(200)}\n`
    )

    runHook({
      ...request,
      stop_hook_active: true,
      last_assistant_message:
        `Continue a paused task. Read \`${written}\` in full before doing anything else. ` +
        `\n[clauditor-banked-handoff]`,
    })

    const stored = readFileSync(written, 'utf-8')
    expect(stored).toContain('judgement source: banked')
    expect(stored).toContain('Ship the thing')
    // Nothing left behind in clauditor's own directory to diverge from it.
    expect(existsSync(pendingPath())).toBe(false)
    // And the request is answered: no second ask at the same size.
    expect(JSON.parse(runHook(request))).toEqual({})
  }, 30_000)

  it('re-banks into the same file once the session has grown a long way', () => {
    const request = {
      session_id: 'e2e-regrown',
      transcript_path: transcript,
      stop_hook_active: false,
      hook_event_name: 'Stop',
    }
    runHook(request)
    const written = join(home, '.claude', 'handoffs', 'first-20260909-1400.md')
    mkdirSync(dirname(written), { recursive: true })
    writeFileSync(written, `# Handoff: First\n\n## Mission\nAt 400k.\n${'x'.repeat(200)}\n`)
    runHook({
      ...request,
      stop_hook_active: true,
      last_assistant_message: `Read \`${written}\`\n[clauditor-banked-handoff]`,
    })

    // 400k at the bank, and the default growth step is 100k.
    const grown = transcriptWithPeak(90, 560_000)
    const reason = JSON.parse(runHook({ ...request, transcript_path: grown })).reason as string
    expect(reason).toContain('Overwrite this file')
    expect(reason).toContain(written)
  }, 30_000)

  it('re-banks into the document it produced when the reply was the fallback', () => {
    // The fallback route captures the judgement out of the reply, so the
    // document lives at clauditor's own pending path and no file in the
    // handoffs directory names it. Recording an empty path there sent the
    // re-bank off to write a second document, leaving the first to rot.
    const request = {
      session_id: 'e2e-fallback',
      transcript_path: transcript,
      stop_hook_active: false,
      hook_event_name: 'Stop',
    }
    runHook(request)
    runHook({
      ...request,
      stop_hook_active: true,
      last_assistant_message:
        `## Mission\nAt 400k, in the reply.\n${'x'.repeat(200)}\n[clauditor-banked-handoff]`,
    })
    expect(existsSync(pendingPath())).toBe(true)

    // 400k at the bank, and the default growth step is 100k.
    const grown = transcriptWithPeak(90, 560_000)
    const reason = JSON.parse(runHook({ ...request, transcript_path: grown })).reason as string
    expect(reason).toContain('Overwrite this file')
    expect(reason).toContain(pendingPath())
  }, 30_000)

  it('never tells a session to overwrite a handoff it did not write', () => {
    // The journal state is per DIRECTORY, so a session that has never banked
    // still reads the previous session's promotedPath out of it. Passed
    // through as the rewrite path, the instruction tells the model to
    // "overwrite this file, which your earlier bank in this session
    // produced", naming another session's document. This destroyed a real
    // handoff on 2026-09-10: c3bdfd2a overwrote d231272f's.
    const first = {
      session_id: 'e2e-owner',
      transcript_path: transcript,
      stop_hook_active: false,
      hook_event_name: 'Stop',
    }
    runHook(first)
    const theirs = join(home, '.claude', 'handoffs', 'theirs-20260909-1400.md')
    mkdirSync(dirname(theirs), { recursive: true })
    writeFileSync(theirs, `# Handoff: Theirs\n\n## Mission\nTheirs.\n${'x'.repeat(200)}\n`)
    runHook({
      ...first,
      stop_hook_active: true,
      last_assistant_message: `Read \`${theirs}\`\n[clauditor-banked-handoff]`,
    })

    // A different session, in the same directory, banking for the first time.
    const reason = JSON.parse(
      runHook({ ...first, session_id: 'e2e-newcomer' })
    ).reason as string
    expect(reason).not.toContain('Overwrite this file')
    expect(reason).not.toContain(theirs)
    // It is a first bank, so it is given the naming rule instead.
    expect(reason).toContain('Write the handoff with the Write tool to')
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
