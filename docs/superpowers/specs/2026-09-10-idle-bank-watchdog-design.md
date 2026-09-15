# Idle-bank watchdog

**Date**: 2026-09-10
**Status**: approved design, not yet implemented
**Repo**: clauditor
**Related**: `src/features/resume-advisory.ts` (the consumer of what this produces)

## Problem

A session banks its judgement half only when the Stop hook sees it cross
`rotation.minPeakContext`, currently 200,000. Five gate declines proved live on
2026-09-10 sat at 56.1k, 80.9k, 99.7k, 109.8k and 179.2k. None of those
sessions ever banks. When one goes idle and its prompt cache expires, the
conversation is gone: nothing records what it decided, and reconstructing it
costs a full cold read.

Banking is cheap only while the cache is warm. The measured banking turn costs
about `0.2 x C + 37,000` units warm, against roughly `1.0 x C` cold. So there
is a window, the last few minutes of the one-hour cache TTL, in which a
session that is about to be abandoned can still record itself cheaply. Nothing
currently uses that window, because clauditor has no process running while a
session is idle.

## Non-goals

- Not a replacement for the Stop-hook bank gate. That still governs
  mid-session banking, and this design adds no second opinion about it.
- Not an AI decision. An agent reading a transcript cold pays about `1.0 x C`
  as fresh input against `0.2 x C` warm in-session, and produces a worse
  document, having the transcript but not the reasoning. The timing and the
  eligibility test are entirely mechanical; the only model involvement is the
  woken session writing its own handoff, which it is uniquely placed to do.
- Not a model-driven timer. Each reset would be a tool call, an extra round
  trip at `0.1 x C`, about 20,000 units per user message at 200k context.
- No new blocking mechanism. Stephen: "having the three of those is really
  confusing and I never know which to use."

## Decisions taken

| Decision | Choice | Why |
|---|---|---|
| What it does when it fires | Wakes the session over its inbox socket and has it bank | A notification only helps if you are at the machine, which is when the watchdog is least needed |
| The wind-down guard | A woken bank does **not** arm `blockAfterBank` | You never asked for this bank; returning to a session that refuses edits until you find the continue phrase is a trap |
| Where the timer lives | A detached one-shot spawned by the Stop hook, replaced on every turn | No new install surface. It dies on reboot, which costs nothing, because the server-side cache TTL keeps running while the machine sleeps and the cache is dead on wake anyway |
| Arming threshold | `RESUME_BREAK_EVEN`, 65,000 | An idle bank is terminal and is never paid twice, so it only has to beat the entry cost of the handoff it produces. Four of the five observed declines would have been saved |
| New config key | None | `rotation.threshold` and `rotation.minTurns` are already vestigial and unread; a fourth key earns its place only once the research lands |

## Architecture

Three pieces, with the logic concentrated in the pure one.

### `src/features/idle-watchdog.ts`

Pure. Holds the constants, the timer-file schema, the socket-message
composition, and above all `shouldIdleBank(facts): IdleBankVerdict`, which is
where every rule lives and where the tests point.

```ts
export const IDLE_BANK_DELAY_MS = 55 * 60 * 1000

export interface IdleBankFacts {
  msSinceLastTurn: number | null
  peakContext: number
  alreadyBanked: boolean
  growthSinceBank: number
  rotationEnabled: boolean
  reBankGrowth: number
  socketExists: boolean
}

export type IdleBankVerdict =
  | { act: 'bank' }
  | { act: 'notify'; reason: 'cache-cold' | 'session-gone' }
  | { act: 'nothing'; reason: string }
```

Fifty-five minutes, not sixty: the woken turn has to start, run and write
before the cache expires, and five minutes is the margin for that.

### `src/hooks/idle-timer.ts`

The detached process. Sleeps to `firesAt`, re-reads every fact from disk,
calls `shouldIdleBank`, and acts on the verdict. It holds no state of its own;
everything it believed at arm time is re-derived, because it has been asleep
for the best part of an hour and any of it may have changed.

### `src/hooks/stop.ts`

Gains arming only, at the very end of the handler, well clear of
`captureBankedHandoff`, which does not move.

## Lifecycle

1. The Stop hook resolves its own `claude` PID by walking the parent chain
   until a `/tmp/cc-socks/<pid>.sock` matches. Verified: a hook process reaches
   it in three hops. Sockets are keyed by PID, never by session id, so this
   mapping can only be made while the session is alive.
2. It reads the previous `~/.clauditor/timers/<sessionId>.json`, if any, and
   kills the `timerPid` named there.
3. It writes a fresh timer file at mode 0600. On the **first** Stop of the
   session it also spawns the detached, `unref`'d poller; on every subsequent
   Stop it only rewrites `firesAt` in the file, which is a single cheap write.
4. The poller wakes once a minute, re-reads the file, and goes back to sleep
   unless `now >= firesAt`. So an active session's timer is perpetually pushed
   out by a file write rather than by killing and respawning a process.

Measured, this matters: a sleeping node process is 42MB and takes about 50ms to
start, against 1.2MB for a shell sleeper. Respawning one per turn per session,
with the nine to ten sessions typically open here, would have held roughly
420MB and paid a spawn and a kill on every single turn. One long-lived poller
per session costs a stat per minute.

### Timer file

`~/.clauditor/timers/<sessionId>.json`, mode 0600:

```json
{
  "sessionId": "3d878c40-...",
  "timerPid": 81742,
  "claudePid": 71011,
  "socketPath": "/tmp/cc-socks/71011.sock",
  "token": "<CLAUDE_CODE_MESSAGING_TOKEN>",
  "cwd": "/Users/stephen.dawson/Documents/GitHub/clauditor",
  "transcriptPath": "/Users/stephen.dawson/.claude/projects/.../3d878c40-....jsonl",
  "armedAt": 1789048000000,
  "firesAt": 1789051300000
}
```

The token is copied from the Stop hook's environment because macOS does not
let the timer read another process's environment later. It is the same secret
that already sits in every hook's environment; the new exposure is that a copy
now outlives the process. Mode 0600 in a directory the user owns, and the file
is deleted as soon as the timer fires or is replaced.

## Eligibility, re-checked at fire time

`shouldIdleBank` returns `bank` only when all of these hold:

- the transcript's last turn is still at least `IDLE_BANK_DELAY_MS` old, so the
  session really is idle and no newer timer has superseded this one
- peak context is at least `RESUME_BREAK_EVEN`, computed with `contextTokens`
  imported from `cost-tracker`, never open-coded
- the session has not banked, or has grown by at least `reBankGrowth` since
- `rotation.enabled`
- the socket still exists
- the cache is still warm, `msSinceLastTurn < CACHE_TTL_MS`

A cold cache returns `notify`, not `bank`: banking after expiry costs full
price and the whole saving has already been lost. A missing socket returns
`notify` for the same reason, the session having exited.

## Delivery

The connection is opened only once the message is composed, because a
connection idle for 30 seconds is closed. The first line written is the auth
frame:

```
{"type":"auth","token":"<token>"}
```

Without it, a session running `--dangerously-skip-permissions` cannot verify
the sender as an own-child, holds the message for an approval nobody is present
to give, and it expires after five minutes. On macOS, process evidence counts
only while the posting process is still running, so the timer must stay alive
until the write completes.

The bank request itself is composed by `bankInstruction(peakContext, {
rewritePath })`, the same exported function the Stop hook calls, so the two
paths cannot drift. Two constraints carry over from it unchanged:

- `rewritePath` is `readSessionBank(sessionId)?.handoffPath ?? ''`, the
  session's **own** bank. It is never `state.promotedPath`. Passing the
  per-directory promoted path told a session that had never banked to
  overwrite another session's document, and destroyed a real handoff on
  2026-09-10.
- The timer calls `recordBankRequest(cwd, now, peakContext, sessionId)` before
  sending, exactly as the Stop hook does. Without it an unanswered request
  re-fires at every subsequent stop.

## The unattended bank

`markSessionBanked` gains a third option, `continueAfterBank?: boolean`,
written straight into the marker. Before sending, the timer sets an
`unattended` flag in the journal state; the bank path reads it, passes
`continueAfterBank: true`, and clears it. `isBlockedAfterBank` already honours
`bank.continueAfterBank !== true`, so no guard logic changes.

The result: a woken bank produces a handoff and leaves the session working.

## Cleanup

Three mechanisms, because the clean signal is not guaranteed to arrive.

1. **SessionEnd hook.** Claude Code exposes `SessionEnd` (`executeSessionEndHooks`
   in the binary). On a clean exit it kills `timerPid` and deletes the timer
   file. This is the stop-on-close signal and the normal path.
2. **Socket disappearance.** A poller whose `socketPath` no longer exists exits
   of its own accord and removes its file. This covers the cases SessionEnd
   cannot: SIGKILL, a crash, a terminal window closed from under the process.
3. **Sweep on arming.** Any Stop hook, in any session, removes timer files whose
   `timerPid` is dead or whose socket is gone. This collects anything the first
   two missed.

The cost is therefore bounded by open sessions, never by transcripts on disk.

**This needs an installer change.** Adding `SessionEnd` means `install.ts`
writes a new hook into `~/.claude/settings.json`. That file is on the
do-not-touch list, so the reinstall is yours to run, not mine.

## Cost, measured

The population the watchdog can fire on is sessions that are **open** and idle.
A closed session has no socket: the poller wakes, finds nothing to talk to, and
exits without spending anything. Measuring closed sessions overstates the cost
by roughly a factor of three, which an earlier draft of this spec did.

Over 740 sessions carrying usage records:

- **211 sessions (28.5%) had at least one idle gap over 55 minutes**, 309 gaps
  in total, median gap 2.9 hours. Each gap is one firing that the user
  subsequently came back from, so 309 is the waste case, and an upper bound on
  it: some of those gaps are resumes of sessions that had been closed, which
  would never have fired.
- Of those 211 sessions, 211 are above 65k peak and 207 above 100k. **The
  threshold is nearly irrelevant to this population**: choosing 65k over 100k
  costs four sessions. `RESUME_BREAK_EVEN` stands.
- A live sample taken while writing this found 9 open sessions and none idle
  past 55 minutes.

The value case, sessions left open and never returned to, cannot be measured
from transcripts, because nothing records whether a session was still open when
its last turn ended. It is bounded below by zero and above by every session
that ends in silence.

## Failure modes

| Failure | Behaviour |
|---|---|
| Machine sleeps through the window | Fires late, sees a cold cache, notifies instead of banking. No wasted bank |
| Laptop sleeps before the window | Not solvable, and not worth solving. The cache TTL is server-side wall-clock, so sleeping does not pause it: a machine that sleeps at T+10 and wakes at T+3h returns to a cache that died at T+60 whatever ran locally. Banking before sleep would need a sleep-onset listener, and macOS gives such a listener seconds of warning against a bank that takes tens of seconds |
| Session exited | Socket gone, notifies |
| Message held for approval | Nothing happens, and it is invisible from outside. Every attempt is written to the activity log so the silence is auditable |
| Two timers race | The loser aborts on the fire-time eligibility re-check |
| Timer orphaned after Claude Code exits | Wakes, finds no socket, notifies, exits |
| Timer file unreadable or corrupt | Arming rewrites it; a timer that cannot read it exits without acting |
| SessionEnd does not fire (SIGKILL, crash, terminal closed) | The poller notices the socket has gone within a minute and exits; the next Stop in any session sweeps the file |

## Testing

- `shouldIdleBank` unit-tested exhaustively across every fact combination that
  changes the verdict. This is the whole of the logic and the whole of the risk.
- Socket delivery tested against a fake Unix server in a temp directory,
  asserting the auth frame is the first line written.
- Arming tested by arming twice and asserting the first `timerPid` is dead and
  the file names the second.
- Timer-file permissions asserted at 0600.
- No test wakes a real session.

## Risks accepted

- **The token now exists on disk.** Mitigated by 0600 and a short life, but it
  is a longer-lived copy of a live secret than exists today.
- **The held-message failure is undetectable from outside.** The first live
  exercise must be a session under observation.
- **An unattended turn runs with the session's own permissions** while nobody
  is watching. It is confined to writing a handoff, but the permission grant
  is the session's, not a reduced one.
