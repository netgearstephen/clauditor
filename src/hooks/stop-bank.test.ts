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

// Every test here runs the built hook in a subprocess, at roughly 1.7s an
// invocation, so the 5s default is a load-sensitive coin toss rather than a
// timeout. Set once for the describe; the per-test values below predate it.
describe('Stop hook banking, end to end', { timeout: 30_000 }, () => {
  let home: string
  let transcript: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clauditor-bank-e2e-'))
    // Sized against the default request floor, not arbitrary: the re-bank
    // cases bank at 70 turns and grow to 90, so 90 - 70 is exactly 20 and
    // clears a floor of 20 with nothing to spare (20 < 20 is false, by one
    // request). Raise the default minRequestsSinceBank above 20
    // and size these two numbers with it, or they fail for a reason that has
    // nothing to do with what they are testing.
    transcript = transcriptWithPeak(70, 400_000)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function runHook(input: Record<string, unknown>): string {
    return execFileSync('node', [HOOK], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      // Pointed at a directory that never has anything in it: these tests
      // are not about arming, and the real /tmp/cc-socks this suite runs
      // under is not empty (it holds the very Claude session running these
      // tests), so leaving the default would have every one of them walk up
      // to a genuine ancestor and spawn a real, detached poller nothing here
      // ever cleans up.
      env: { ...process.env, HOME: home, CLAUDITOR_SOCK_DIR: join(home, 'no-cc-socks') },
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

  it('gives a re-banking session its tools back, so it can write the file it was told to overwrite', () => {
    // The guard blocks Write after a bank. The re-bank instruction says
    // "Overwrite this file", so without the stamp the request cannot be
    // answered by writing at all, and the whole document lands in the
    // terminal instead.
    const request = {
      session_id: 'e2e-rebank-guard',
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

    const marker = join(home, '.clauditor', 'banked', 'e2e-rebank-guard.json')
    const banked = JSON.parse(readFileSync(marker, 'utf-8'))
    expect(banked.bankRequestedAt ?? 0).toBeLessThanOrEqual(banked.bankedAt)

    // 400k at the bank, and the default growth step is 100k.
    const grown = transcriptWithPeak(90, 560_000)
    runHook({ ...request, transcript_path: grown })

    const after = JSON.parse(readFileSync(marker, 'utf-8'))
    expect(after.bankRequestedAt).toBeGreaterThan(after.bankedAt)
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
    // rewrite of this context is exactly what banking avoids. By design, the
    // request floor applies to a first bank too, not just a re-bank: twelve
    // turns is under the default floor of twenty, so it is cleared here to
    // isolate the size gate this test is actually about. See the sibling
    // test below for what the shipped defaults do to this same session.
    mkdirSync(join(home, '.clauditor'), { recursive: true })
    writeFileSync(
      join(home, '.clauditor', 'config.json'),
      JSON.stringify({ rotation: { trigger: { minRequestsSinceBank: 0 } } })
    )
    const out = runHook({
      session_id: 'e2e-0011',
      transcript_path: transcriptWithPeak(12, 260_000),
      stop_hook_active: false,
      hook_event_name: 'Stop',
    })
    expect(JSON.parse(out).decision).toBe('block')
  })

  it('holds a short-but-large first bank back under the shipped defaults', () => {
    // The measured design, not an accident: bankedAtTurn is 0 for a session
    // that has never banked, so the request floor applies to a first bank
    // exactly as it would to a re-bank, and twelve turns does not clear the
    // default of twenty. No config is written here, unlike the case above,
    // so this is the only test on the Stop path that exercises the shipped
    // default rather than an explicit value, and it is the evidence that
    // this session's first bank waits under what actually ships.
    const out = runHook({
      session_id: 'e2e-0011b',
      transcript_path: transcriptWithPeak(12, 260_000),
      stop_hook_active: false,
      hook_event_name: 'Stop',
    })
    expect(JSON.parse(out)).toEqual({})
  })

  it('honours a per-model gate override, not just the top-level default', () => {
    // Proof the resolved trigger is actually consulted: the default gate
    // (150k) would bank this 260k-peak session, same as the case above. A
    // per-model override raising the gate for this session's model must
    // change that verdict, or the Stop hook could be reading a stale
    // constant while a green suite never noticed.
    mkdirSync(join(home, '.clauditor'), { recursive: true })
    writeFileSync(
      join(home, '.clauditor', 'config.json'),
      JSON.stringify({
        rotation: { trigger: { perModel: { 'claude-opus-5': { peakContext: 500_000 } } } },
      })
    )
    const out = runHook({
      session_id: 'e2e-per-model-gate',
      transcript_path: transcriptWithPeak(40, 260_000),
      stop_hook_active: false,
      hook_event_name: 'Stop',
    })
    expect(JSON.parse(out)).toEqual({})
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

describe('Idle timer arming, end to end', () => {
  let home: string
  let transcript: string
  // The poller this test's own run spawns, if any: it sleeps for up to a
  // minute between wakes, so removing its timer file does not stop it. It
  // must be killed here, not left to the module-wide sweep.
  let armedPid: number | null

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clauditor-bank-e2e-arm-'))
    transcript = join(home, 'arm.jsonl')
    writeFileSync(
      transcript,
      JSON.stringify({ type: 'user', cwd: CWD, timestamp: new Date().toISOString() })
    )
    armedPid = null
  })

  afterEach(() => {
    if (armedPid) {
      try {
        process.kill(armedPid, 'SIGKILL')
      } catch {
        // Already dead is fine; that is the common case.
      }
    }
    rmSync(home, { recursive: true, force: true })
  })

  function runHook(input: Record<string, unknown>): string {
    return execFileSync('node', [HOOK], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        CLAUDITOR_SOCK_DIR: join(home, 'cc-socks'),
        CLAUDE_CODE_MESSAGING_TOKEN: 'e2e-token',
      },
      timeout: 30_000,
    })
  }

  it('arms without the hook environment token, which is not the credential the poller uses', () => {
    // The poller authenticates with the session's peerToken, read from its
    // key file at fire time. Gating arming on CLAUDE_CODE_MESSAGING_TOKEN
    // withheld the timer over a secret nothing goes on to present, and
    // writing it into the file left a live credential on disk for 55 minutes
    // for no purpose at all.
    const sockDir = join(home, 'cc-socks')
    mkdirSync(sockDir, { recursive: true })
    writeFileSync(join(sockDir, `${process.pid}.sock`), '')

    execFileSync('node', [HOOK], {
      input: JSON.stringify({
        session_id: 'e2e-untokened',
        transcript_path: transcript,
        stop_hook_active: true,
        hook_event_name: 'Stop',
      }),
      encoding: 'utf-8',
      env: { ...process.env, HOME: home, CLAUDITOR_SOCK_DIR: sockDir },
      timeout: 30_000,
    })

    const timerPath = join(home, '.clauditor', 'timers', 'e2e-untokened.json')
    const file = JSON.parse(readFileSync(timerPath, 'utf-8'))
    armedPid = file.timerPid
    expect(file.socketPath).toBe(join(sockDir, `${process.pid}.sock`))
    expect(file).not.toHaveProperty('token')
  })

  it('arms one idle timer per session, and pushes it out on the next stop', () => {
    const sockDir = join(home, 'cc-socks')
    mkdirSync(sockDir, { recursive: true })
    // Stand in for the session's own socket: the hook walks its parent chain,
    // and the test runner is an ancestor of the hook process.
    writeFileSync(join(sockDir, `${process.pid}.sock`), '')

    const input = {
      session_id: 'e2e-armed',
      transcript_path: transcript,
      stop_hook_active: true,
      hook_event_name: 'Stop',
    }
    const timerPath = join(home, '.clauditor', 'timers', 'e2e-armed.json')

    runHook(input)
    const first = JSON.parse(readFileSync(timerPath, 'utf-8'))
    armedPid = first.timerPid
    expect(first.firesAt - first.armedAt).toBe(55 * 60 * 1000)

    runHook(input)
    const second = JSON.parse(readFileSync(timerPath, 'utf-8'))
    // Pushed out, and the same poller is still the one watching it.
    expect(second.firesAt).toBeGreaterThanOrEqual(first.firesAt)
    expect(second.timerPid).toBe(first.timerPid)
  }, 30_000)

  it('respawns a poller for a timer file wedged at pid zero', () => {
    // process.kill(0, 0) signals the process group and succeeds, so a timer
    // file carrying timerPid 0 reads as alive: the Stop hook rewrites firesAt
    // and never respawns, and the sweep will not reap it either. The session
    // is unwatched for ever, with a file on disk carrying a live auth token.
    const sockDir = join(home, 'cc-socks')
    mkdirSync(sockDir, { recursive: true })
    const sock = join(sockDir, `${process.pid}.sock`)
    writeFileSync(sock, '')
    const timerPath = join(home, '.clauditor', 'timers', 'e2e-wedged.json')
    mkdirSync(dirname(timerPath), { recursive: true })
    writeFileSync(
      timerPath,
      JSON.stringify({
        sessionId: 'e2e-wedged',
        timerPid: 0,
        claudePid: process.pid,
        socketPath: sock,
        token: 'stale-token',
        cwd: CWD,
        transcriptPath: transcript,
        armedAt: Date.now() - 1_000,
        firesAt: Date.now() + 60_000,
      })
    )

    runHook({
      session_id: 'e2e-wedged',
      transcript_path: transcript,
      stop_hook_active: true,
      hook_event_name: 'Stop',
    })

    const file = JSON.parse(readFileSync(timerPath, 'utf-8'))
    armedPid = file.timerPid
    expect(file.timerPid).toBeGreaterThan(0)
  }, 30_000)

  it('arms nothing at all when rotation is switched off', () => {
    // A detached 42MB node process per session, asleep for 55 minutes, to
    // decide 'nothing' on waking. The sweep still has to run, which is why
    // only the spawn is gated, but nothing may be left on disk either: a
    // timer file naming no poller is the wedge item 2 is about.
    mkdirSync(join(home, '.clauditor'), { recursive: true })
    writeFileSync(
      join(home, '.clauditor', 'config.json'),
      JSON.stringify({ rotation: { enabled: false } })
    )
    const sockDir = join(home, 'cc-socks')
    mkdirSync(sockDir, { recursive: true })
    writeFileSync(join(sockDir, `${process.pid}.sock`), '')

    runHook({
      session_id: 'e2e-rotation-off',
      transcript_path: transcript,
      stop_hook_active: true,
      hook_event_name: 'Stop',
    })

    expect(existsSync(join(home, '.clauditor', 'timers', 'e2e-rotation-off.json'))).toBe(false)
  }, 30_000)
})

/**
 * The same arming assertion again, through the entry point production uses.
 *
 * `install.ts` writes `clauditor hook stop`, whose bin is `dist/cli.js`, and
 * tsup inlines the Stop hook into that bundle. So `import.meta.url` there is
 * `dist/cli.js`, not `dist/hooks/stop.js`, and a poller path resolved relative
 * to it lands one directory too high. Every installed poller died on boot with
 * `Cannot find module` and no test noticed, because every test drove
 * `dist/hooks/stop.js`, where the same relative path happens to resolve.
 *
 * Hence the two things this asserts that the other arming test cannot: the
 * installed entry point, and a poller that is actually alive rather than a
 * file naming a pid.
 */
describe('Idle timer arming through the installed entry point', () => {
  const CLI = resolve(__dirname, '..', '..', 'dist', 'cli.js')
  let home: string
  let transcript: string
  let armedPid: number | null

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clauditor-bank-e2e-cli-'))
    transcript = join(home, 'arm.jsonl')
    writeFileSync(
      transcript,
      JSON.stringify({ type: 'user', cwd: CWD, timestamp: new Date().toISOString() })
    )
    armedPid = null
  })

  afterEach(() => {
    if (armedPid) {
      try {
        process.kill(armedPid, 'SIGKILL')
      } catch {
        // Already dead is fine, and is what this test fails on.
      }
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('spawns a poller that is still alive after the hook returns', () => {
    const sockDir = join(home, 'cc-socks')
    mkdirSync(sockDir, { recursive: true })
    writeFileSync(join(sockDir, `${process.pid}.sock`), '')

    execFileSync('node', [CLI, 'hook', 'stop'], {
      input: JSON.stringify({
        session_id: 'e2e-cli-armed',
        transcript_path: transcript,
        stop_hook_active: true,
        hook_event_name: 'Stop',
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        CLAUDITOR_SOCK_DIR: sockDir,
        CLAUDE_CODE_MESSAGING_TOKEN: 'e2e-cli-token',
      },
      timeout: 30_000,
    })

    const timerPath = join(home, '.clauditor', 'timers', 'e2e-cli-armed.json')
    const file = JSON.parse(readFileSync(timerPath, 'utf-8'))
    armedPid = file.timerPid
    expect(file.timerPid).toBeGreaterThan(0)

    // The poller has to get through awaitOwnArming and into its poll loop, so
    // liveness is checked after a pause rather than at once: a poller that
    // dies on boot takes a few tens of milliseconds to do it.
    execFileSync('sleep', ['1'])
    expect(isAlive(file.timerPid)).toBe(true)
  }, 30_000)
})

/** Does this pid still exist? Signal 0 delivers nothing. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
