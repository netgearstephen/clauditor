# Idle-bank watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a session that goes idle with a warm cache one last chance to bank its judgement half, by waking it over its own inbox socket 55 minutes after its last turn.

**Architecture:** Three pieces. `src/features/idle-watchdog.ts` is pure and holds every rule, the timer-file schema and the message composition. `src/hooks/idle-timer.ts` is a detached poller that wakes once a minute, re-reads every fact from disk and acts on the verdict. `src/hooks/stop.ts` gains arming only, at the end of the handler. A fourth piece, a `SessionEnd` hook, cleans up on a clean exit.

**Tech Stack:** TypeScript, Node 20+, vitest, tsup. No new dependencies: `node:net` for the socket, `node:child_process` for the detached spawn.

**Spec:** `/Users/stephen.dawson/Documents/GitHub/clauditor/docs/superpowers/specs/2026-09-10-idle-bank-watchdog-design.md`

## Global Constraints

- `IDLE_BANK_DELAY_MS` is `55 * 60 * 1000`. Fifty-five, not sixty: the woken turn has to start, run and write before the one-hour cache TTL expires.
- The arming threshold is `RESUME_BREAK_EVEN` (65,000), imported from `src/features/resume-advisory.ts`. No new config key.
- Context sums come from `contextTokens` imported from `src/features/cost-tracker.ts`, via `peakContextTokens`. Never open-code the input-context sum.
- `rewritePath` is always `readSessionBank(sessionId)?.handoffPath ?? ''`, the session's own bank. Never `state.promotedPath`: that destroyed a real handoff on 2026-09-10.
- A woken bank does **not** arm `blockAfterBank`. The user never asked for it and must not return to a session refusing edits.
- The bank request text comes from `bankInstruction(peakContext, { stamp, rewritePath })`, the same exported function the Stop hook calls, so the two paths cannot drift.
- No new blocking mechanism, and no second opinion about the Stop-hook bank gate.
- Timer files live at `~/.clauditor/timers/<sessionId>.json`, mode `0600`.
- British English, no em dashes or en dashes, in code comments as well as prose.
- Do not edit `~/.claude/settings.json`. Task 7 changes `install.ts` only; running the reinstall is Stephen's.
- Do not commit anything unless Stephen asks. Steps below that say "commit" are to be offered, not run unasked.
- No test wakes a real session.

---

### Task 1: The verdict, and the constants it needs

**Files:**
- Create: `src/features/idle-watchdog.ts`
- Test: `src/features/idle-watchdog.test.ts`

**Interfaces:**
- Consumes: `RESUME_BREAK_EVEN` from `./resume-advisory.js`, `CACHE_TTL_MS` from `./journal.js`.
- Produces: `IDLE_BANK_DELAY_MS`, `IdleBankFacts`, `IdleBankVerdict`, `shouldIdleBank(facts: IdleBankFacts): IdleBankVerdict`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/features/idle-watchdog.test.ts
import { describe, it, expect } from 'vitest'
import {
  shouldIdleBank,
  IDLE_BANK_DELAY_MS,
  type IdleBankFacts,
} from './idle-watchdog.js'

/** A session that is idle, large, warm, unbanked and still listening. */
const eligible: IdleBankFacts = {
  msSinceLastTurn: IDLE_BANK_DELAY_MS + 1_000,
  peakContext: 120_000,
  alreadyBanked: false,
  growthSinceBank: 0,
  rotationEnabled: true,
  reBankGrowth: 100_000,
  socketExists: true,
}

describe('shouldIdleBank', () => {
  it('banks a large, idle, warm session that is still listening', () => {
    expect(shouldIdleBank(eligible)).toEqual({ act: 'bank' })
  })

  it('does nothing when a newer turn has landed since the timer was armed', () => {
    // The timer wakes on a clock; the transcript is the authority on whether
    // the session is actually idle.
    const verdict = shouldIdleBank({ ...eligible, msSinceLastTurn: 60_000 })
    expect(verdict.act).toBe('nothing')
  })

  it('does nothing when the transcript cannot be read', () => {
    expect(shouldIdleBank({ ...eligible, msSinceLastTurn: null }).act).toBe('nothing')
  })

  it('does nothing below the resume break-even', () => {
    // Below it the handoff's own entry cost eats the whole saving.
    expect(shouldIdleBank({ ...eligible, peakContext: 64_999 }).act).toBe('nothing')
  })

  it('banks exactly at the resume break-even', () => {
    expect(shouldIdleBank({ ...eligible, peakContext: 65_000 })).toEqual({ act: 'bank' })
  })

  it('does nothing when rotation is switched off', () => {
    expect(shouldIdleBank({ ...eligible, rotationEnabled: false }).act).toBe('nothing')
  })

  it('does nothing when the session has already banked and has not grown', () => {
    expect(
      shouldIdleBank({ ...eligible, alreadyBanked: true, growthSinceBank: 40_000 }).act
    ).toBe('nothing')
  })

  it('banks again once the session has grown past the re-bank step', () => {
    expect(
      shouldIdleBank({ ...eligible, alreadyBanked: true, growthSinceBank: 100_000 })
    ).toEqual({ act: 'bank' })
  })

  it('notifies rather than banks once the cache has gone cold', () => {
    // Banking after expiry costs full price, and the saving it existed for
    // has already been lost.
    expect(
      shouldIdleBank({ ...eligible, msSinceLastTurn: 61 * 60 * 1000 })
    ).toEqual({ act: 'notify', reason: 'cache-cold' })
  })

  it('notifies when the session has exited and its socket has gone', () => {
    expect(shouldIdleBank({ ...eligible, socketExists: false })).toEqual({
      act: 'notify',
      reason: 'session-gone',
    })
  })

  it('says nothing about a small session whose socket has gone', () => {
    // Nothing to say: it was never worth banking.
    expect(
      shouldIdleBank({ ...eligible, socketExists: false, peakContext: 10_000 }).act
    ).toBe('nothing')
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/features/idle-watchdog.test.ts`
Expected: FAIL, "Failed to resolve import ./idle-watchdog.js".

- [ ] **Step 3: Write the module**

```typescript
// src/features/idle-watchdog.ts
import { CACHE_TTL_MS } from './journal.js'
import { RESUME_BREAK_EVEN } from './resume-advisory.js'

/**
 * How long a session must sit idle before its handoff is banked unasked.
 *
 * Fifty-five minutes, against a one-hour cache TTL. The woken turn has to
 * start, read and write before the cache expires, and five minutes is the
 * margin for that. Firing at sixty would reliably wake a session into a cold
 * cache, which is the one case where banking is not worth doing.
 */
export const IDLE_BANK_DELAY_MS = 55 * 60 * 1000

/** Everything the verdict depends on, all of it re-read at fire time. */
export interface IdleBankFacts {
  /** Age of the last turn in the transcript; null when it cannot be read. */
  msSinceLastTurn: number | null
  /** Peak context of the session, from peakContextTokens. */
  peakContext: number
  /** Has this session already paid for a bank, in any directory? */
  alreadyBanked: boolean
  /** Peak growth since that bank, 0 when it has not banked. */
  growthSinceBank: number
  /** config.rotation.enabled. */
  rotationEnabled: boolean
  /** config.rotation.reBankGrowth. */
  reBankGrowth: number
  /** Is the session's inbox socket still there? */
  socketExists: boolean
}

export type IdleBankVerdict =
  | { act: 'bank' }
  | { act: 'notify'; reason: 'cache-cold' | 'session-gone' }
  | { act: 'nothing'; reason: string }

/**
 * Should this idle session be woken and asked to bank?
 *
 * Every rule lives here, and nothing here touches the filesystem or the
 * clock: the timer re-reads the facts and this decides on them. That split is
 * what makes the whole of the risk unit-testable, since the timer itself
 * cannot be exercised without a live session.
 */
export function shouldIdleBank(facts: IdleBankFacts): IdleBankVerdict {
  if (facts.msSinceLastTurn === null) {
    return { act: 'nothing', reason: 'transcript unreadable' }
  }
  // The timer wakes on a clock. The transcript decides whether the session is
  // idle, so a turn taken since arming cancels the firing outright.
  if (facts.msSinceLastTurn < IDLE_BANK_DELAY_MS) {
    return { act: 'nothing', reason: 'a turn landed since arming' }
  }
  if (!facts.rotationEnabled) return { act: 'nothing', reason: 'rotation disabled' }
  if (facts.peakContext < RESUME_BREAK_EVEN) {
    return { act: 'nothing', reason: 'below the resume break-even' }
  }
  if (facts.alreadyBanked && facts.growthSinceBank < facts.reBankGrowth) {
    return { act: 'nothing', reason: 'already banked and not materially grown' }
  }
  // Both remaining cases are worth saying out loud, and neither is worth
  // paying for: a cold bank costs full price, and a session that has exited
  // has nothing to wake.
  if (!facts.socketExists) return { act: 'notify', reason: 'session-gone' }
  if (facts.msSinceLastTurn >= CACHE_TTL_MS) {
    return { act: 'notify', reason: 'cache-cold' }
  }
  return { act: 'bank' }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/features/idle-watchdog.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 6: Commit (only if Stephen has asked for commits)**

```bash
git add src/features/idle-watchdog.ts src/features/idle-watchdog.test.ts
git commit -m "feat(watchdog): decide when an idle session is worth waking"
```

---

### Task 2: The timer file, and sweeping dead ones

**Files:**
- Modify: `src/features/idle-watchdog.ts`
- Test: `src/features/idle-watchdog.test.ts`

**Interfaces:**
- Consumes: Task 1's module.
- Produces: `TIMERS_DIR`, `IdleTimerFile`, `timerFilePath(sessionId)`, `writeTimerFile(file)`, `readTimerFile(sessionId)`, `deleteTimerFile(sessionId)`, `sweepTimerFiles(now?)`, `isProcessAlive(pid)`.

- [ ] **Step 1: Write the failing tests**

Add to `src/features/idle-watchdog.test.ts`. The module reads `homedir()`, so these use the same fresh-import trick as `journal.test.ts`.

```typescript
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, vi } from 'vitest'

async function importFresh(tempDir: string) {
  vi.resetModules()
  vi.doMock('node:os', () => ({ homedir: () => tempDir }))
  return await import('./idle-watchdog.js')
}

describe('the timer file', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-timer-'))
  })
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    vi.doUnmock('node:os')
  })

  const file = (over: Record<string, unknown> = {}) => ({
    sessionId: 'sess-1',
    timerPid: process.pid,
    claudePid: process.pid,
    socketPath: '/tmp/cc-socks/1.sock',
    token: 'secret-token',
    cwd: '/home/user/project-a',
    transcriptPath: '/home/user/.claude/projects/p/sess-1.jsonl',
    armedAt: 1_000,
    firesAt: 2_000,
    ...over,
  })

  it('round-trips what the timer needs to act', async () => {
    const w = await importFresh(tempDir)
    w.writeTimerFile(file() as never)
    expect(w.readTimerFile('sess-1')).toEqual(file())
  })

  it('is readable only by its owner, because it carries a live token', async () => {
    const w = await importFresh(tempDir)
    w.writeTimerFile(file() as never)
    const mode = statSync(w.timerFilePath('sess-1')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('returns null for a session with no timer, and for a corrupt file', async () => {
    const w = await importFresh(tempDir)
    expect(w.readTimerFile('nobody')).toBeNull()
    mkdirSync(w.TIMERS_DIR, { recursive: true })
    writeFileSync(w.timerFilePath('broken'), '{ not json')
    expect(w.readTimerFile('broken')).toBeNull()
  })

  it('refuses a session id that is not a plain file name', async () => {
    const w = await importFresh(tempDir)
    expect(w.timerFilePath('../../escape')).toBeNull()
    expect(w.readTimerFile('../../escape')).toBeNull()
  })

  it('sweeps a timer whose process is dead', async () => {
    const w = await importFresh(tempDir)
    // PID 2^22 is above every pid_max in use and owns nothing.
    w.writeTimerFile(file({ sessionId: 'dead', timerPid: 4_194_304 }) as never)
    w.sweepTimerFiles()
    expect(existsSync(w.timerFilePath('dead')!)).toBe(false)
  })

  it('sweeps a timer whose session has exited, socket and all', async () => {
    const w = await importFresh(tempDir)
    w.writeTimerFile(file({ sessionId: 'gone', socketPath: join(tempDir, 'no.sock') }) as never)
    w.sweepTimerFiles()
    expect(existsSync(w.timerFilePath('gone')!)).toBe(false)
  })

  it('leaves a live timer alone', async () => {
    const w = await importFresh(tempDir)
    const sock = join(tempDir, 'live.sock')
    writeFileSync(sock, '')
    w.writeTimerFile(file({ sessionId: 'live', socketPath: sock }) as never)
    w.sweepTimerFiles()
    expect(existsSync(w.timerFilePath('live')!)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/features/idle-watchdog.test.ts`
Expected: FAIL, "w.writeTimerFile is not a function".

- [ ] **Step 3: Write the implementation**

```typescript
// appended to src/features/idle-watchdog.ts
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** One file per armed session. Never keyed by anything but the session id. */
export const TIMERS_DIR = resolve(homedir(), '.clauditor', 'timers')

/**
 * What the timer is told at arm time.
 *
 * The token is copied out of the Stop hook's environment because macOS does
 * not let one process read another's environment later, and the timer needs
 * it to authenticate to the inbox socket an hour after the hook has exited.
 * That is a live secret with a longer life than it has today, which is why
 * the file is 0600 and is deleted the moment it fires or is replaced.
 */
export interface IdleTimerFile {
  sessionId: string
  timerPid: number
  claudePid: number
  socketPath: string
  token: string
  cwd: string
  transcriptPath: string
  armedAt: number
  firesAt: number
}

/** Path for a session's timer file, or null if the id cannot be a filename. */
export function timerFilePath(sessionId: string): string | null {
  if (!sessionId || !/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) return null
  return resolve(TIMERS_DIR, `${sessionId}.json`)
}

export function writeTimerFile(file: IdleTimerFile): void {
  const path = timerFilePath(file.sessionId)
  if (!path) return
  try {
    mkdirSync(TIMERS_DIR, { recursive: true })
    writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 })
  } catch {}
}

export function readTimerFile(sessionId: string): IdleTimerFile | null {
  const path = timerFilePath(sessionId)
  if (!path) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as IdleTimerFile
  } catch {
    return null
  }
}

export function deleteTimerFile(sessionId: string): void {
  const path = timerFilePath(sessionId)
  if (!path) return
  try {
    unlinkSync(path)
  } catch {}
}

/** Is this pid still running? Signal 0 tests without delivering anything. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Remove timer files whose timer is dead or whose session has exited.
 *
 * The third cleanup mechanism, and the one that needs no signal to arrive.
 * SessionEnd covers the clean exit and the poller covers its own socket going
 * away, but neither survives a SIGKILL, so any Stop hook in any session sweeps
 * what is left. The cost is therefore bounded by open sessions, never by
 * transcripts on disk.
 */
export function sweepTimerFiles(): void {
  let names: string[]
  try {
    names = readdirSync(TIMERS_DIR).filter((n) => n.endsWith('.json'))
  } catch {
    return
  }
  for (const name of names) {
    const file = readTimerFile(name.replace(/\.json$/, ''))
    if (!file) {
      try {
        unlinkSync(resolve(TIMERS_DIR, name))
      } catch {}
      continue
    }
    if (!isProcessAlive(file.timerPid) || !existsSync(file.socketPath)) {
      deleteTimerFile(file.sessionId)
    }
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/features/idle-watchdog.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit (only if Stephen has asked for commits)**

```bash
git add src/features/idle-watchdog.ts src/features/idle-watchdog.test.ts
git commit -m "feat(watchdog): keep one timer file per armed session"
```

---

### Task 3: Delivery over the inbox socket

**Files:**
- Modify: `src/features/idle-watchdog.ts`
- Test: `src/features/idle-watchdog.test.ts`

**Interfaces:**
- Consumes: Task 2's `IdleTimerFile`.
- Produces: `sendToInbox(socketPath: string, token: string, message: string): Promise<boolean>`.

Note for the implementer: sockets are keyed by PID, at `/tmp/cc-socks/<pid>.sock`, never by session id. The auth frame must be the first line written, or a session running `--dangerously-skip-permissions` holds the message for an approval nobody is there to give, and it expires after five minutes. The connection is opened only once the message is composed, because a connection left idle for 30 seconds is closed.

- [ ] **Step 1: Write the failing test**

```typescript
import { createServer } from 'node:net'

describe('sendToInbox', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-sock-'))
  })
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('authenticates before it says anything else', async () => {
    const w = await importFresh(tempDir)
    const sockPath = join(tempDir, 'inbox.sock')
    const lines: string[] = []
    const server = createServer((c) => {
      c.on('data', (b) => lines.push(...b.toString().split('\n').filter(Boolean)))
    })
    await new Promise<void>((r) => server.listen(sockPath, r))

    const ok = await w.sendToInbox(sockPath, 'secret-token', 'bank please')
    await new Promise((r) => setTimeout(r, 50))
    server.close()

    expect(ok).toBe(true)
    expect(JSON.parse(lines[0])).toEqual({ type: 'auth', token: 'secret-token' })
    expect(lines[1]).toContain('bank please')
  })

  it('reports failure rather than throwing when nothing is listening', async () => {
    const w = await importFresh(tempDir)
    await expect(w.sendToInbox(join(tempDir, 'absent.sock'), 't', 'hi')).resolves.toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/features/idle-watchdog.test.ts -t sendToInbox`
Expected: FAIL, "w.sendToInbox is not a function".

- [ ] **Step 3: Write the implementation**

```typescript
// appended to src/features/idle-watchdog.ts
import { connect } from 'node:net'

/**
 * Hand a message to a live session's inbox.
 *
 * The auth frame goes first, on its own line. Without it a session running
 * with permissions skipped cannot verify the sender as its own child, holds
 * the message for an approval nobody is present to give, and lets it expire
 * after five minutes. On macOS the process evidence counts only while the
 * sender is still running, so this resolves after the write has flushed and
 * the caller must stay alive until it does.
 */
export function sendToInbox(
  socketPath: string,
  token: string,
  message: string
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    const socket = connect(socketPath)
    socket.on('error', () => done(false))
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ type: 'auth', token })}\n`)
      socket.write(`${JSON.stringify({ type: 'message', message })}\n`, () => {
        socket.end()
        done(true)
      })
    })
  })
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/features/idle-watchdog.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit (only if Stephen has asked for commits)**

```bash
git add src/features/idle-watchdog.ts src/features/idle-watchdog.test.ts
git commit -m "feat(watchdog): deliver a woken bank request over the inbox socket"
```

---

### Task 4: An unattended bank leaves the session working

**Files:**
- Modify: `src/features/journal.ts` (`markSessionBanked`, and a new `unattendedBank` flag on the state)
- Test: `src/features/journal.test.ts`

**Interfaces:**
- Consumes: `updateJournalState`, `markSessionBanked`, `readSessionBank`, `isBlockedAfterBank` from `journal.ts`.
- Produces: `markSessionBanked(sessionId, cwd, now, { peakContext, handoffPath, continueAfterBank })`; `markUnattendedBank(cwd, sessionId)`; `takeUnattendedBank(cwd, sessionId): boolean` (reads the flag and clears it in one update).

Why the flag rather than a parameter: the timer sends a message and exits. The bank it asks for is captured later, by the Stop hook in the woken session, which has no way to know the request was unattended unless it is written down.

- [ ] **Step 1: Write the failing tests**

```typescript
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
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/features/journal.test.ts -t unattended`
Expected: FAIL, "j.markUnattendedBank is not a function", and the first test failing on `isBlockedAfterBank` returning true.

- [ ] **Step 3: Write the implementation**

In `markSessionBanked`, accept and write the third option:

```typescript
export function markSessionBanked(
  sessionId: string | null,
  cwd: string | null,
  now: number = Date.now(),
  {
    peakContext = 0,
    handoffPath = '',
    continueAfterBank = false,
  }: { peakContext?: number; handoffPath?: string; continueAfterBank?: boolean } = {}
): void {
  const path = bankMarkerPath(sessionId)
  if (!path) return
  try {
    mkdirSync(BANKED_DIR, { recursive: true })
    writeFileSync(
      path,
      // A bank nobody asked for writes the continue flag straight in, so the
      // guard never arms. isBlockedAfterBank already honours it, so no guard
      // logic changes here.
      JSON.stringify({ bankedAt: now, cwd, peakContext, handoffPath, continueAfterBank }, null, 2)
    )
  } catch {
    return
  }
  // ...pruning unchanged
}
```

Add the two flag helpers next to `readJournalState`, and the field to `JournalState` and `EMPTY_STATE` (`unattendedBankSession: ''`):

```typescript
/** Record that the bank about to be requested was nobody's idea but ours. */
export function markUnattendedBank(cwd: string | null, sessionId: string | null): void {
  updateJournalState(cwd, (state) => ({ ...state, unattendedBankSession: sessionId ?? '' }))
}

/**
 * Read the unattended flag and clear it, in one update.
 *
 * Cleared on read because the next bank in this directory may well be one the
 * user asked for, and a flag left set would silently disarm the guard for it.
 */
export function takeUnattendedBank(cwd: string | null, sessionId: string | null): boolean {
  let taken = false
  updateJournalState(cwd, (state) => {
    taken = state.unattendedBankSession !== '' && state.unattendedBankSession === (sessionId ?? '')
    return taken ? { ...state, unattendedBankSession: '' } : state
  })
  return taken
}
```

Then, at the two `markSessionBanked` call sites in `journal.ts` (in `adoptBankedHandoff` and in `storeJudgement`), pass the flag through:

```typescript
markSessionBanked(sessionId, cwd, now, {
  peakContext,
  handoffPath: target,
  continueAfterBank: takeUnattendedBank(cwd, sessionId),
})
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/features/journal.test.ts`
Expected: PASS. Then `npx vitest run` for the whole suite, and `npx tsc --noEmit`.

- [ ] **Step 5: Commit (only if Stephen has asked for commits)**

```bash
git add src/features/journal.ts src/features/journal.test.ts
git commit -m "feat(watchdog): leave a session working after a bank it did not ask for"
```

---

### Task 5: The detached poller

**Files:**
- Create: `src/hooks/idle-timer.ts`
- Test: `src/hooks/idle-timer.test.ts`
- Modify: `tsup.config.ts` (hook entries are listed explicitly: add `'hooks/idle-timer': 'src/hooks/idle-timer.ts'` to the library-and-hooks entry map)

**Interfaces:**
- Consumes: `shouldIdleBank`, `IDLE_BANK_DELAY_MS`, `readTimerFile`, `deleteTimerFile`, `sendToInbox` (Tasks 1 to 3); `readTurns`, `peakContextTokens`, `msSinceLastTurn`, `readSessionBank`, `recordBankRequest`, `bankInstruction`, `handoffStamp`, `markUnattendedBank` from `journal.ts`; `readConfig` from `../config.js`; `logActivity` from `../features/activity-log.js`.
- Produces: `gatherIdleFacts(file: IdleTimerFile, now?: number): IdleBankFacts`, `runIdleTimerOnce(sessionId: string, now?: number): Promise<'bank' | 'notify' | 'nothing' | 'waiting'>`, and a `main()` that polls once a minute.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/hooks/idle-timer.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'

async function importFresh(tempDir: string) {
  vi.resetModules()
  vi.doMock('node:os', () => ({ homedir: () => tempDir }))
  return {
    timer: await import('./idle-timer.js'),
    w: await import('../features/idle-watchdog.js'),
  }
}

const CWD = '/home/user/project-a'

/** A transcript whose last turn is `ageMs` old and whose peak is `peak`. */
function transcript(dir: string, ageMs: number, peak: number): string {
  const path = join(dir, 'idle.jsonl')
  const ts = new Date(Date.now() - ageMs).toISOString()
  const recs = [
    { type: 'user', cwd: CWD, timestamp: ts },
    {
      type: 'assistant',
      timestamp: ts,
      message: {
        model: 'claude-opus-5',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: peak - 10,
        },
      },
    },
  ]
  writeFileSync(path, recs.map((r) => JSON.stringify(r)).join('\n'))
  return path
}

describe('the idle timer', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-idle-'))
  })
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    vi.doUnmock('node:os')
  })

  async function arm(over: Record<string, unknown> = {}) {
    const { timer, w } = await importFresh(tempDir)
    const sockPath = join(tempDir, 'inbox.sock')
    const received: string[] = []
    const server = createServer((c) => {
      c.on('data', (b) => received.push(...b.toString().split('\n').filter(Boolean)))
    })
    await new Promise<void>((r) => server.listen(sockPath, r))
    w.writeTimerFile({
      sessionId: 'idle-1',
      timerPid: process.pid,
      claudePid: process.pid,
      socketPath: sockPath,
      token: 'tok',
      cwd: CWD,
      transcriptPath: transcript(tempDir, 56 * 60 * 1000, 300_000),
      armedAt: Date.now() - 56 * 60 * 1000,
      firesAt: Date.now() - 60_000,
      ...over,
    } as never)
    return { timer, w, server, received }
  }

  it('waits while the fire time is still ahead', async () => {
    const { timer, server } = await arm({ firesAt: Date.now() + 600_000 })
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('waiting')
    server.close()
  })

  it('sends the bank request the Stop hook would have sent', async () => {
    const { timer, server, received } = await arm()
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('bank')
    await new Promise((r) => setTimeout(r, 50))
    server.close()
    expect(JSON.parse(received[0]).type).toBe('auth')
    expect(received[1]).toContain('cheapest moment')
  })

  it('records the request, so an unanswered one does not re-fire at every stop', async () => {
    const { timer, w, server } = await arm()
    await timer.runIdleTimerOnce('idle-1')
    server.close()
    const j = await import('../features/journal.js')
    expect(j.readJournalState(CWD).bankRequestedSession).toBe('idle-1')
  })

  it('flags the bank as unattended, so the session is not left blocked', async () => {
    const { timer, server } = await arm()
    await timer.runIdleTimerOnce('idle-1')
    server.close()
    const j = await import('../features/journal.js')
    expect(j.takeUnattendedBank(CWD, 'idle-1')).toBe(true)
  })

  it('does not send anything to a session that has taken a turn since arming', async () => {
    const { timer, server, received } = await arm({
      transcriptPath: transcript(tempDir, 60_000, 300_000),
    })
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('nothing')
    server.close()
    expect(received).toEqual([])
  })

  it('deletes its own file once it has acted', async () => {
    const { timer, w, server } = await arm()
    await timer.runIdleTimerOnce('idle-1')
    server.close()
    expect(existsSync(w.timerFilePath('idle-1')!)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/hooks/idle-timer.test.ts`
Expected: FAIL, "Failed to resolve import ./idle-timer.js".

- [ ] **Step 3: Write the implementation**

```typescript
// src/hooks/idle-timer.ts
import { existsSync } from 'node:fs'
import { readConfig } from '../config.js'
import { logActivity } from '../features/activity-log.js'
import {
  bankInstruction,
  handoffStamp,
  markUnattendedBank,
  msSinceLastTurn,
  peakContextTokens,
  readSessionBank,
  readTurns,
  recordBankRequest,
} from '../features/journal.js'
import {
  deleteTimerFile,
  readTimerFile,
  sendToInbox,
  shouldIdleBank,
  type IdleBankFacts,
  type IdleTimerFile,
} from '../features/idle-watchdog.js'

/** How often the poller looks at its own file. A stat a minute, no more. */
const POLL_INTERVAL_MS = 60_000

/**
 * Re-derive every fact from disk.
 *
 * Nothing believed at arm time is trusted: this process has been asleep for
 * the best part of an hour, and the session may have taken twenty turns,
 * banked, changed directory or exited since.
 */
export function gatherIdleFacts(file: IdleTimerFile, now: number = Date.now()): IdleBankFacts {
  const config = readConfig()
  const { turns } = readTurns(file.transcriptPath)
  const peakContext = peakContextTokens(turns)
  const bank = readSessionBank(file.sessionId)
  return {
    msSinceLastTurn: msSinceLastTurn(file.transcriptPath, now),
    peakContext,
    alreadyBanked: bank !== null,
    growthSinceBank: bank ? peakContext - bank.peakContext : 0,
    rotationEnabled: config.rotation.enabled,
    reBankGrowth: config.rotation.reBankGrowth,
    socketExists: existsSync(file.socketPath),
  }
}

/**
 * One pass: is it time, and if so what does the verdict say to do?
 *
 * Every outcome is logged, including the ones that do nothing, because a
 * message held for an approval nobody is there to give is invisible from
 * outside and the log is the only place the silence is auditable.
 */
export async function runIdleTimerOnce(
  sessionId: string,
  now: number = Date.now()
): Promise<'bank' | 'notify' | 'nothing' | 'waiting'> {
  const file = readTimerFile(sessionId)
  if (!file) return 'nothing'
  if (!existsSync(file.socketPath)) {
    deleteTimerFile(sessionId)
    return 'nothing'
  }
  if (now < file.firesAt) return 'waiting'

  const facts = gatherIdleFacts(file, now)
  const verdict = shouldIdleBank(facts)
  const session = sessionId.slice(0, 8)

  if (verdict.act === 'bank') {
    // Written down before the message goes out, exactly as the Stop hook does
    // it: an unanswered request that was never recorded fires again at every
    // stop for the rest of the session.
    recordBankRequest(file.cwd, now, facts.peakContext, sessionId)
    // The woken session must not come back to a guard it never armed.
    markUnattendedBank(file.cwd, sessionId)
    const sent = await sendToInbox(
      file.socketPath,
      file.token,
      bankInstruction(facts.peakContext, {
        stamp: handoffStamp(),
        // The session's OWN bank. Never state.promotedPath: that told a
        // session which had never banked to overwrite another session's
        // document, and destroyed a real handoff on 2026-09-10.
        rewritePath: readSessionBank(sessionId)?.handoffPath ?? '',
      })
    )
    await logActivity({
      type: 'context_warning',
      session,
      message: sent
        ? `idle bank requested at ${facts.peakContext} peak context`
        : `idle bank could not be delivered at ${facts.peakContext} peak context`,
    })
    deleteTimerFile(sessionId)
    return 'bank'
  }

  if (verdict.act === 'notify') {
    await logActivity({
      type: 'context_warning',
      session,
      message: `idle session not banked (${verdict.reason}) at ${facts.peakContext} peak context`,
    })
    deleteTimerFile(sessionId)
    return 'notify'
  }

  await logActivity({
    type: 'context_warning',
    session,
    message: `idle timer stood down: ${verdict.reason}`,
  })
  deleteTimerFile(sessionId)
  return 'nothing'
}

/** Poll until this session's timer has fired, been superseded or gone away. */
async function main(): Promise<void> {
  const sessionId = process.argv[2]
  if (!sessionId) return
  for (;;) {
    const outcome = await runIdleTimerOnce(sessionId)
    if (outcome !== 'waiting') return
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
}

// Run only when this module is the entry point: see isHookEntry.
if (process.argv[1]?.endsWith('idle-timer.js')) {
  main().catch(() => process.exit(0))
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/hooks/idle-timer.test.ts`
Expected: PASS, 6 tests. Then `npm run build` and confirm `dist/hooks/idle-timer.js` exists. It will not until the tsup entry above is added, because the hook entries are listed one by one rather than globbed.

- [ ] **Step 5: Commit (only if Stephen has asked for commits)**

```bash
git add src/hooks/idle-timer.ts src/hooks/idle-timer.test.ts tsup.config.ts
git commit -m "feat(watchdog): wake an idle session and ask it to bank"
```

---

### Task 6: Arming, from the Stop hook

**Files:**
- Modify: `src/hooks/stop.ts` (a new `armIdleTimer(input)` called at the very end of `handleStopHook`, well clear of `captureBankedHandoff`, which does not move)
- Modify: `src/features/idle-watchdog.ts` (`resolveClaudePid`)
- Test: `src/features/idle-watchdog.test.ts`, `src/hooks/stop-bank.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces: `resolveClaudePid(startPid?: number): { pid: number; socketPath: string } | null`; `armIdleTimer(input: StopHookInput): void` (private to `stop.ts`).

Lifecycle, from the spec: resolve the `claude` PID by walking the parent chain until a `/tmp/cc-socks/<pid>.sock` matches (three hops, verified live). Read the previous timer file and kill its `timerPid` only when respawning. On the **first** Stop of the session, spawn the detached, `unref`'d poller; on every later Stop, rewrite `firesAt` only, which is one cheap write. A sleeping node process is 42MB against 1.2MB for a shell sleeper, and respawning one per turn across the nine or ten sessions typically open here would hold roughly 420MB.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/features/idle-watchdog.test.ts
describe('resolveClaudePid', () => {
  it('finds the ancestor whose socket exists', async () => {
    const w = await importFresh(tempDir)
    const sockDir = join(tempDir, 'cc-socks')
    mkdirSync(sockDir, { recursive: true })
    writeFileSync(join(sockDir, `${process.ppid}.sock`), '')
    const found = w.resolveClaudePid(process.pid, sockDir)
    expect(found?.pid).toBe(process.ppid)
    expect(found?.socketPath).toBe(join(sockDir, `${process.ppid}.sock`))
  })

  it('returns null when no ancestor is listening', async () => {
    const w = await importFresh(tempDir)
    expect(w.resolveClaudePid(process.pid, join(tempDir, 'empty'))).toBeNull()
  })
})
```

```typescript
// src/hooks/stop-bank.test.ts, driven through the built hook
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
  runHook(input)
  const first = JSON.parse(
    readFileSync(join(home, '.clauditor', 'timers', 'e2e-armed.json'), 'utf-8')
  )
  expect(first.firesAt - first.armedAt).toBe(55 * 60 * 1000)

  runHook(input)
  const second = JSON.parse(
    readFileSync(join(home, '.clauditor', 'timers', 'e2e-armed.json'), 'utf-8')
  )
  // Pushed out, and the same poller is still the one watching it.
  expect(second.firesAt).toBeGreaterThanOrEqual(first.firesAt)
  expect(second.timerPid).toBe(first.timerPid)
}, 30_000)
```

The e2e test needs `CLAUDITOR_SOCK_DIR` honoured by the hook so it can point at a temp directory; add that to `resolveClaudePid`'s default (`process.env.CLAUDITOR_SOCK_DIR ?? '/tmp/cc-socks'`) and set it in `runHook`'s `env`.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/features/idle-watchdog.test.ts -t resolveClaudePid`
Expected: FAIL, "w.resolveClaudePid is not a function".

- [ ] **Step 3: Write the implementation**

```typescript
// appended to src/features/idle-watchdog.ts
import { execFileSync } from 'node:child_process'

/** Where Claude Code puts one inbox socket per live session process. */
export const SOCK_DIR = process.env.CLAUDITOR_SOCK_DIR ?? '/tmp/cc-socks'

/**
 * Find the `claude` process this hook is running under.
 *
 * Sockets are keyed by PID, never by session id, so this mapping can only be
 * made while the session is alive, which is why arming captures it rather than
 * the timer resolving it later. A hook process reaches its own claude in three
 * hops up the parent chain, verified live; the cap is generous against that.
 */
export function resolveClaudePid(
  startPid: number = process.pid,
  sockDir: string = SOCK_DIR
): { pid: number; socketPath: string } | null {
  let pid = startPid
  for (let hop = 0; hop < 8 && pid > 1; hop++) {
    const socketPath = resolve(sockDir, `${pid}.sock`)
    if (existsSync(socketPath)) return { pid, socketPath }
    try {
      pid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
        encoding: 'utf-8',
      }).trim())
    } catch {
      return null
    }
    if (!Number.isFinite(pid)) return null
  }
  return null
}
```

```typescript
// src/hooks/stop.ts, called last in handleStopHook, after outputDecision's
// callers and never before captureBankedHandoff
import { spawn } from 'node:child_process'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  IDLE_BANK_DELAY_MS,
  isProcessAlive,
  readTimerFile,
  resolveClaudePid,
  sweepTimerFiles,
  writeTimerFile,
} from '../features/idle-watchdog.js'

/**
 * Push this session's idle timer out to 55 minutes from now.
 *
 * Cheap on every turn but the first: an existing, live poller is left running
 * and only `firesAt` is rewritten. Killing and respawning a node process per
 * turn would hold roughly 420MB across the sessions typically open here, and
 * pay a spawn and a kill for nothing.
 */
function armIdleTimer(input: StopHookInput): void {
  // Anything left behind by a session that was killed goes now: no signal is
  // guaranteed to arrive, so every stop in every session sweeps.
  sweepTimerFiles()

  const claude = resolveClaudePid()
  if (!claude) return
  const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN
  if (!token || !input.transcript_path) return

  const now = Date.now()
  const existing = readTimerFile(input.session_id)
  const alive = existing !== null && isProcessAlive(existing.timerPid)

  const file = {
    sessionId: input.session_id,
    timerPid: alive ? existing!.timerPid : 0,
    claudePid: claude.pid,
    socketPath: claude.socketPath,
    token,
    cwd: extractCwd(input.transcript_path) ?? process.cwd(),
    transcriptPath: input.transcript_path,
    armedAt: now,
    firesAt: now + IDLE_BANK_DELAY_MS,
  }

  if (alive) {
    writeTimerFile(file)
    return
  }

  // The build is ESM, so there is no __dirname to lean on. The poller sits
  // beside this hook in dist/hooks.
  const here = dirname(fileURLToPath(import.meta.url))
  const child = spawn(
    process.execPath,
    [resolvePath(here, 'idle-timer.js'), input.session_id],
    { detached: true, stdio: 'ignore' }
  )
  child.unref()
  writeTimerFile({ ...file, timerPid: child.pid ?? 0 })
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm run build && npx vitest run`
Expected: PASS, whole suite. Then `npx tsc --noEmit`.

- [ ] **Step 5: Check nothing is left running**

Run: `ps -eo pid,command | grep idle-timer | grep -v grep`
Expected: nothing from the test run. If a poller is left behind, the test forgot to remove its timer file: fix the test, not the poller.

- [ ] **Step 6: Commit (only if Stephen has asked for commits)**

```bash
git add src/hooks/stop.ts src/features/idle-watchdog.ts src/features/idle-watchdog.test.ts src/hooks/stop-bank.test.ts
git commit -m "feat(watchdog): arm an idle timer from the stop hook"
```

---

### Task 7: SessionEnd cleanup, and the installer entry

**Files:**
- Create: `src/hooks/session-end.ts`
- Test: `src/hooks/session-end.test.ts`
- Modify: `src/install.ts:40-65` (add `SessionEnd` to `CLAUDITOR_HOOKS`)
- Modify: `tsup.config.ts` (add `'hooks/session-end': 'src/hooks/session-end.ts'`)

**Interfaces:**
- Consumes: `readTimerFile`, `deleteTimerFile`, `isProcessAlive` (Task 2).
- Produces: `handleSessionEndHook(): Promise<void>`.

This is the normal cleanup path. The other two, the poller noticing its socket has gone and the sweep on arming, exist because this signal is not guaranteed to arrive.

- [ ] **Step 1: Write the failing test**

```typescript
// src/hooks/session-end.test.ts
it('kills the timer and removes its file when the session closes', async () => {
  const { hook, w } = await importFresh(tempDir)
  // A real child to kill, so the test proves the signal lands rather than
  // asserting on a mock.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  w.writeTimerFile({ ...file(), sessionId: 'closing', timerPid: child.pid! } as never)

  await hook.handleSessionEndHook({ session_id: 'closing' } as never)

  expect(existsSync(w.timerFilePath('closing')!)).toBe(false)
  await new Promise((r) => setTimeout(r, 100))
  expect(w.isProcessAlive(child.pid!)).toBe(false)
})

it('does nothing for a session that was never armed', async () => {
  const { hook } = await importFresh(tempDir)
  await expect(hook.handleSessionEndHook({ session_id: 'never' } as never)).resolves.toBeUndefined()
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/hooks/session-end.test.ts`
Expected: FAIL, "Failed to resolve import ./session-end.js".

- [ ] **Step 3: Write the implementation**

```typescript
// src/hooks/session-end.ts
import { isHookEntry, readStdin } from './shared.js'
import { deleteTimerFile, isProcessAlive, readTimerFile } from '../features/idle-watchdog.js'

/**
 * Stop this session's idle timer on a clean exit.
 *
 * The normal path, and the only one that is prompt. A SIGKILL, a crash or a
 * terminal closed from under the process never gets here, which is what the
 * poller's own socket check and the sweep on arming are for.
 */
export async function handleSessionEndHook(
  input: { session_id?: string } | null
): Promise<void> {
  const sessionId = input?.session_id
  if (!sessionId) return
  const file = readTimerFile(sessionId)
  if (!file) return
  if (file.timerPid && isProcessAlive(file.timerPid)) {
    try {
      process.kill(file.timerPid)
    } catch {}
  }
  deleteTimerFile(sessionId)
}

// Run only when this module is the entry point: see isHookEntry.
if (isHookEntry('session-end')) {
  readStdin()
    .then((raw) => handleSessionEndHook(JSON.parse(raw)))
    .catch(() => {})
    .finally(() => {
      process.stdout.write('{}')
      process.exit(0)
    })
}
```

Then add the installer entry, in `CLAUDITOR_HOOKS`, in the same shape as the others:

```typescript
  SessionEnd: {
    matcher: '',
    hooks: [{ type: 'command', command: getHookCommand('session-end') }],
  },
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm run build && npx vitest run && npx tsc --noEmit`
Expected: PASS, whole suite; no typecheck output.

- [ ] **Step 5: Hand the reinstall to Stephen**

Do NOT run the installer and do NOT edit `~/.claude/settings.json`. Tell Stephen the `SessionEnd` hook is ready and that `clauditor install` is his to run, and that until he runs it the other two cleanup mechanisms carry the load.

- [ ] **Step 6: Commit (only if Stephen has asked for commits)**

```bash
git add src/hooks/session-end.ts src/hooks/session-end.test.ts src/install.ts tsup.config.ts
git commit -m "feat(watchdog): stop the idle timer when the session closes"
```

---

## First live exercise

The spec records that a message held for an approval nobody gives is invisible from outside, so the first firing must be watched. After Task 6, with a session under observation: set `firesAt` in that session's timer file to a moment about a minute out, leave the session idle, and watch `~/.clauditor/activity.log` for the `idle bank requested` line and the session for the woken turn. If nothing arrives, the message was held, and the log line is the only evidence that the attempt happened at all.

## Where this plan departs from the spec

The spec's testing section asks for arming to be tested by "arming twice and
asserting the first `timerPid` is dead and the file names the second". That
describes a kill-and-respawn, which its own lifecycle section rules out on
cost: respawning a 42MB node process per turn across the sessions typically
open here would hold roughly 420MB. Task 6 follows the lifecycle section, so
the test asserts the opposite: the same `timerPid` is still there and only
`firesAt` has moved. The kill path is exercised only where it really happens,
when the previous poller is found dead.

## Open questions this plan does not settle

- Whether `rotation.blockAfterBank` should default to `false` (carried, unanswered). Task 4 makes the woken bank safe either way.
- Whether the guard's tool list should say `Agent` rather than `Task`. Untouched here.
- Whether `RESUME_BREAK_EVEN` generalises to 1M-context sessions. The threshold is nearly irrelevant to the measured population (211 of 211 idle sessions are above 65k), so this is not worth blocking on.
