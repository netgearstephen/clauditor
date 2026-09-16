<p align="center">
  <h1 align="center">clauditor</h1>
  <p align="center">
    <strong>Bank a handoff while the cache is warm. Never interrupt the user.</strong>
  </p>
  <p align="center">
    <a href="https://github.com/netgearstephen/clauditor/blob/main/LICENSE"><img src="https://img.shields.io/github/license/netgearstephen/clauditor" alt="MIT License"></a>
  </p>
</p>

---

This is a fork of [IyadhKhalfallah/clauditor](https://github.com/IyadhKhalfallah/clauditor). Upstream blocks a session when its waste factor gets too high and makes the user type "continue" to get their context back. This fork removes every path that interrupts the user and replaces them with one mechanism: a handoff banked by the model itself, once, at the moment it is cheapest to write.

The rest of upstream is intact: cost tracking, cache-health diagnostics, the error index, the hub, the dashboard and the reports.

## The problem

Every turn of a Claude Code session re-reads the whole conversation. With prompt caching that is cheap, at 0.1x the base input rate, as long as the cache is warm. Once it goes cold (an hour of idleness on the 1-hour TTL), the next turn rewrites the whole context at 2x.

So the same handoff document costs about twenty times more to write from a cold session than from a warm one. Upstream's answer was to block the session before it got big. That interrupts the user at the moment they have decided what to say, and it fired on a waste factor that turned out to be wrong: measured over 207 local sessions, the median session being called 3.1x wasteful was actually costing 0.91x its opening rate once each token class was priced at its real rate.

## What this fork does instead

**Nothing blocks the user.** The Stop hook is the single interruption point, and it interrupts the model, not the user, in exactly two cases:

1. **Bank once, warm.** When a session's peak context crosses the banking gate (150k by default) and the cache is still warm, the Stop hook asks the model to write the judgement half of a handoff to `~/.claude/handoffs/<slug>-<timestamp>.md` and reply with a paste-ready prompt. It costs one model turn at read-back rates, and the session carries on afterwards.

2. **Re-bank on drift.** If the session then grows by another 50k of peak context, the same file is overwritten so that a prompt already pasted from it keeps working.

```
clauditor: this session peaked at 214,000 context tokens. The prompt cache is
still warm, which makes this the cheapest moment in the session to write a
handoff ...

Banking one now, so it is ready if and when you rotate. Nothing is being
blocked and the session continues normally after this.
```

The model replies with the resume prompt and nothing else:

```
Continue a paused task. Read `/Users/you/.claude/handoffs/wire-clauditor-into-handoff-20260910-1642.md`
in full before doing anything else. Then summarise your understanding back to me in
3 to 5 bullets and confirm the very next step. ...
```

**Idle sessions are woken to bank.** A session left open and idle would lose its cache without ever banking. The Stop hook arms a detached one-shot timer per session; at 55 minutes of idleness it wakes the session over its own inbox socket and asks it to bank, while the cache is still warm. A woken bank never arms the wind-down guard, so a session you come back to is still working normally. If the socket has gone or the cache is already cold, it notifies instead and spends nothing.

**Resuming costs no model turn.** When a new session starts in a project with a banked handoff, SessionStart shows the resume prompt to the *user* as a system message. The model never reads the handoff until you paste the prompt, so the advisory itself is free:

```
[clauditor]: Your session peaked at 214k tokens 3h ago. The cache is now cold,
so resuming the conversation will cost ~214k tokens plus the token cost of your
message.

Your conversation created a handoff while the cache was still warm. You can
save ~184k tokens ($1.03) while still passing along the context by pasting this
prompt into a new session:

Continue a paused task. Read `...` in full before doing anything else. ...
```

The advisory is offered once per handoff, not to every session for a week.

## The two-mode summary

A session gets ONE summary, produced one of two ways:

| Mode | Source | Cost | When |
|---|---|---|---|
| **Mechanical** | `handoff-facts.py` over git and the transcript: files touched, commits, verification command | Free, deterministic | Rewritten whenever the session moves, and before every compaction |
| **Augmented** | The mechanical half plus judgement only the model has: decisions and why, dead ends, gotchas, do-not-touch | One model turn, warm | Banked once past the gate, re-banked on drift |

They cannot drift: the augmented document *is* the mechanical one with judgement spliced in, and both call the same facts script. The model is told exactly which sections not to write, because a model asked for "a handoff" will reconstruct a file list from the transcript and that is where paths and SHAs go wrong.

A compaction summary counts as judgement already paid for. If nothing is banked yet when `PostCompact` fires, Claude Code's own summary is banked in its place.

A handoff you write by hand with the `/handoff` skill supersedes the automatic one if it is newer. Exactly one summary is ever offered, never a menu.

> The mechanical half depends on the `/handoff` skill's facts script at `~/.claude/skills/handoff/scripts/handoff-facts.py`. Without it the judgement half still banks, but the assembled document has no mechanical sections.

## The wind-down guard

After a session banks, `PreToolUse` refuses `Edit`, `Write`, `NotebookEdit` and `Task`: any of those would make the banked document describe a session that no longer exists. Bash and reads stay open so the handoff itself can still be updated. Agents already running are unaffected.

Your next message lifts the guard automatically. The hook does not read what you said, only that you said something, so nothing can be triggered by quoting or discussing a phrase. A re-bank request also lifts it for the tools that answer it. Turn it off with `rotation.blockAfterBank: false`.

## Install

This fork is not published to npm or Homebrew. Build it from source:

```bash
git clone https://github.com/netgearstephen/clauditor.git
cd clauditor
npm install
npm run build
ln -sf "$PWD/dist/cli.js" ~/.local/bin/clauditor   # or anywhere on your PATH
clauditor install
```

If you have the upstream package installed, remove it first (`clauditor uninstall`, then `brew uninstall clauditor` or `npm uninstall -g @iyadhk/clauditor`). Hooks are registered as bare `clauditor hook ...` commands, so the binary must be on the PATH Claude Code's hook shell sees.

After pulling changes, `npm run build` is enough; the symlink picks up the new build.

Requires Node.js 20+ and Python 3 for the facts script.

**Supported platforms:** Claude Code CLI, VS Code extension, JetBrains extension. Does **not** work with Claude Code on the web (claude.ai/code).

## How it works

`clauditor install` registers 8 hooks into Claude Code. Every handler runs inside a guard that never lets a hook throw: a broken hook must not take the session down with it.

| Hook | What it does | Blocks? |
|---|---|---|
| `Stop` | Refreshes the mechanical journal, banks the judgement half once past the gate, arms the idle timer, stops compaction loops | The model, to bank |
| `PreToolUse` | Injects known fixes before Bash commands; enforces the wind-down guard | Work tools after a bank |
| `PostToolUse` | Compresses verbose Bash output, records error outcomes, injects cache-health warnings | No |
| `PreCompact` | Forces a journal write before context is discarded | No |
| `PostCompact` | Banks Claude Code's own compaction summary as judgement if nothing is banked yet | No |
| `SessionStart` | Shows the resume advisory to the user; promotes the banked handoff into `~/.claude/handoffs/` | No |
| `SessionEnd` | Kills this session's idle timer and removes its timer file | No |
| `UserPromptSubmit` | Sets a flag that lifts the wind-down guard. Reads nothing, injects nothing | No |

### The idle timer, in detail

The Stop hook resolves its own `claude` PID by walking up the process tree until a `/tmp/cc-socks/<pid>.sock` matches, then writes `~/.clauditor/timers/<sessionId>.json` at mode 0600 with the socket path, messaging token and a `firesAt` 55 minutes out. On the first Stop of a session it spawns a detached poller; on every later Stop it only rewrites `firesAt`. One long-lived poller per session costs a stat per minute, against 42MB and a spawn per turn if it were respawned.

At fire time the poller re-derives every fact from disk and banks only if all of these hold: the last real turn is still 55 minutes old, peak context is at least 65k, the session has not banked or has grown 50k since, rotation is enabled, the socket exists, and the cache is still warm. Otherwise it notifies and exits.

Cleanup is three-way: `SessionEnd` on a clean exit, the poller noticing its socket has gone (crash, SIGKILL, closed terminal), and a sweep on every arming that removes files whose timer PID is dead. Cost is bounded by open sessions, never by transcripts on disk.

The full design, with the measurements behind each threshold, is in [`docs/superpowers/specs/2026-09-10-idle-bank-watchdog-design.md`](docs/superpowers/specs/2026-09-10-idle-bank-watchdog-design.md).

## Configuration

One config file at `~/.clauditor/config.json`, created on `clauditor install`. It carries the deprecated `rotation.minPeakContext`, which a fresh install writes at the same value as `rotation.trigger.peakContext`:

```json
{
  "rotation": {
    "enabled": true,
    "minPeakContext": 150000,
    "trigger": {
      "peakContext": 150000,
      "buffer": 0,
      "minRequestsSinceBank": 20,
      "perModel": {}
    },
    "reBankGrowth": 50000,
    "blockAfterBank": true
  },
  "pricing": {
    "discount": 0,
    "perModel": {}
  },
  "notifications": {
    "desktop": true
  }
}
```

| Setting | Default | Description |
|---|---|---|
| `rotation.enabled` | `true` | Bank handoffs and arm idle timers at all |
| `rotation.trigger.peakContext` | `150000` | The banking gate. See below |
| `rotation.trigger.buffer` | `0` | Tokens to fire early by, without moving the gate itself |
| `rotation.trigger.minRequestsSinceBank` | `20` | Billed requests since the last bank before another one is allowed |
| `rotation.trigger.perModel` | `{}` | Per-field overrides keyed by model prefix, e.g. `{ "claude-haiku-4-5": { "peakContext": 120000 } }`. Use the base key: a suffixed or dated form such as `claude-opus-5[1m]` will not match |
| `rotation.minPeakContext` | `150000` | Deprecated alias for `rotation.trigger.peakContext`. See below |
| `rotation.reBankGrowth` | `50000` | Peak-context growth since the last bank that earns a rewrite. Refreshes 65% of banking sessions, against 34% at 100k |
| `rotation.blockAfterBank` | `true` | Enforce the wind-down guard after a bank |
| `pricing.discount` | `0` | Fraction off list price. See below |
| `pricing.perModel` | `{}` | Per-model discount overrides keyed by model prefix. Use the base key: a suffixed or dated form such as `claude-opus-5[1m]` will not match |
| `notifications.desktop` | `true` | Desktop notifications for cache issues and idle-timer outcomes |

**Pricing can be discounted, and it changes reporting only.** An enterprise
agreement makes list prices wrong, so `~/.clauditor/config.json` takes a
fraction off them:

```json
{
  "pricing": {
    "discount": 0,
    "perModel": { "claude-opus-5": { "discount": 0.04 } }
  }
}
```

Zero by default, which is list price. A per-model entry wins over the
top-level figure, keyed by model prefix, so `claude-opus-5` covers
`claude-opus-5[1m]` and every dated snapshot of it. This moves the dollars
reported and nothing else: a uniform discount scales all five rate classes
equally, so it cancels out of every ratio the handover decision rests on.

**The banking trigger is four knobs, not one.**

```json
{
  "rotation": {
    "trigger": {
      "peakContext": 150000,
      "buffer": 0,
      "minRequestsSinceBank": 20,
      "perModel": { "claude-haiku-4-5": { "peakContext": 120000 } }
    }
  }
}
```

`peakContext` is the gate. 150k, because over 1,392 sessions the steady-state
cost per request bottoms out at a 138k trigger: 150k is 0.2% off that, the old
200k default was 4.9% off, and 300k is 20.9% off. It also leaves headroom below
auto-compact. `buffer` fires early without moving the gate the measurements
were taken against. `minRequestsSinceBank` stops a session that has just banked
from banking again the moment it has grown enough to qualify; a request here is
one billed API request, of which a single prompt is a mean of 26.6. The same
floor applies to a session's first bank, not only a re-bank: a session that has
never banked reads as zero requests since its (nonexistent) last one, so a
short session that reaches the gate inside twenty billed requests waits rather
than banking immediately, on the same reasoning as a re-bank.

A gate above the model's context window is not a late gate, it is no gate: the
peak never reaches it and banking goes quiet. Where the window is known, the
gate is clamped to nine tenths of it and says so once.

`rotation.minPeakContext` still works as an alias for `trigger.peakContext`,
but `trigger.peakContext` wins if both are set. This matters because a fresh
`clauditor install` writes both keys to the same value: hand-editing the
deprecated `minPeakContext` afterwards is then a silent no-op, since the
resolved gate keeps coming from `trigger.peakContext` regardless. Set
`rotation.trigger.peakContext` for a gate that actually moves.

The idle timer's 55-minute delay and 65k arming floor are constants, not config: they are derived from the cache TTL and the measured entry cost of a handoff, and there is nothing to tune until that research changes.

## Cost tracking

The fork corrects several pricing holes that made upstream's figures unreliable:

- Cache writes are billed at their actual TTL rate. The 5m/1h split is carried through from the raw record, and any unattributed remainder is billed at the 1h rate rather than zero.
- Each session is priced with its own model, then summed. Costing the aggregate once repriced every session as whatever the fallback was.
- Non-Anthropic models (Ollama, Claude Code's `<synthetic>` marker) cost zero. Unrecognised `claude-*` IDs still take the loud most-expensive fallback.
- Current model IDs and rates are in the table; stale ones are corrected.

On a two-day sample the reported spend went from $217.81 to $425.86 after these fixes.

`clauditor doctor` judges cache health over the trailing five turns, weighted by volume, and reports `unknown` below eight turns. Upstream took its verdict from the final turn alone, so one large read or a compaction marked a healthy session degraded.

## Dashboard (optional)

```bash
clauditor watch
```

Shows each open session's peak context against the banking gate, and whether its handoff has been banked. It says plainly that nothing blocks.

## All commands

| Command | Description |
|---|---|
| `clauditor` | Quota report (default) |
| `clauditor install` | Register hooks into Claude Code, write default config, install the `/save-skill` skill |
| `clauditor uninstall` | Remove hooks |
| `clauditor watch` | Live dashboard: peak context vs the banking gate |
| `clauditor report` | Per-session token report with cost-weighted growth bars |
| `clauditor share` | Copy-pasteable summary |
| `clauditor time` | Token usage by hour of day |
| `clauditor sessions` | See where your tokens went |
| `clauditor status` | Quick health check (no TUI) |
| `clauditor impact` | Lifetime stats |
| `clauditor activity` | Recent actions log, including every idle-timer attempt |
| `clauditor stats` | Historical usage analysis, priced per model |
| `clauditor doctor` | Scan for cache degradation and buggy Claude Code versions |
| `clauditor suggest-skill` | Find repeating workflows |
| `clauditor knowledge` | Show accumulated errors and file activity |
| `clauditor handoff-report` | Measure how much of the transcript the current project summary preserves |
| `clauditor login` | Sign in to clauditor hub (opens browser, or `--device` for SSH) |

The waste factor shown by `report` and `share` is cost-weighted (each token class at its real rate) and is a diagnostic only. Nothing acts on it.

## Audit-only mode (no hooks)

Skip `clauditor install` and use it as a read-only analytics tool:

```bash
clauditor report      # per-session breakdown
clauditor time        # peak vs off-peak token analysis
clauditor sessions    # where the tokens went
clauditor doctor      # cache health
```

These commands read your session JSONL files directly. No hooks registered, no side effects.

## Project memory

clauditor learns from your sessions and builds per-project knowledge at `~/.clauditor/knowledge/<project>/`.

**Error index with confidence decay.** Records failed commands and their fixes. Each error has a confidence score (0–1) that decays with a 45-day half-life. Typo commands, transient network errors and tiny error messages are filtered at capture time.

**Implicit outcome tracking.** When `PreToolUse` warns about a command and `PostToolUse` sees the result, confidence adjusts automatically: +0.1 on success, -0.15 on failure despite the warning.

**Confidence tiers.** Errors are labeled `confirmed` (0.7+), `observed` (0.4+), `inferred` (0.2+) or `stale` (<0.2), and Claude sees the tier in the injection.

**File tracker.** Tracks edit and read counts across sessions and injects history when Claude touches a hot file (5+ edits across 3+ sessions).

```bash
clauditor knowledge
```

## Team knowledge sync (optional, beta)

```bash
clauditor login            # opens a browser
clauditor login --device   # SSH or headless
```

When connected, `PreToolUse` queries the hub before Bash commands, `PostToolUse` pushes error fragments, and `SessionStart` pulls a compact team brief. `clauditor sync` pushes the current project summary as a team memory, deduplicated by content hash. Knowledge starts developer-scoped and promotes to team scope when several developers report the same issue. No hub is required for solo use.

## Version-aware warnings

clauditor detects sessions run on Claude Code 2.1.69–2.1.89, which have a [confirmed prompt caching bug](https://github.com/anthropics/claude-code/issues/34629) that causes 10–20x token consumption. The warning appears in `clauditor report` and via the hooks.

## Technical details

**What clauditor monitors:**

| Metric | Source | Formula |
|---|---|---|
| Context tokens | JSONL `usage` field | `input + cache_read + cache_create` (output excluded: it is not context) |
| Peak context | Derived | Max context tokens over the session's turns. Peak rather than current, because a compaction drops the current figure while the cold rewrite a handoff avoids is still priced on the high-water mark |
| Effective turn cost | Derived | Each token class at its own rate, cache writes at their TTL rate |
| Cache ratio | JSONL `usage` field | `cache_read ÷ (input + cache_read + cache_create)`, aggregated over the trailing 5 turns |

**Hook communication:**

| Hook | Mechanism | Why |
|---|---|---|
| `Stop` | `decision: "block"` + reason | Asks the model to bank, or stops a loop |
| `PreToolUse` | `additionalContext` / `decision: "block"` | Known fixes; the wind-down guard |
| `PostToolUse` | `additionalContext` | Cache-health warnings, error guidance |
| `PreCompact` | File write | Journal refresh at the compaction boundary |
| `PostCompact` | File write | Banks Claude Code's own summary |
| `SessionStart` | `systemMessage` | Resume advisory to the user, not the model |
| `SessionEnd` | File delete + kill | Stops the idle timer |
| `UserPromptSubmit` | File write | Lifts the wind-down guard |
| Idle timer | Unix socket, auth frame first | Wakes an idle session to bank |

**Where things live:**

| Path | What |
|---|---|
| `~/.claude/handoffs/<slug>-<stamp>.md` | Banked and hand-written handoffs, the files the paste prompt names |
| `~/.clauditor/journals/<encoded-cwd>/` | Mechanical journal, journal state, pending judgement |
| `~/.clauditor/banked/<sessionId>.json` | Per-session bank marker: what was banked, at what peak, and whether the guard is lifted |
| `~/.clauditor/timers/<sessionId>.json` | Armed idle timer (0600, deleted on fire or replace) |
| `~/.clauditor/knowledge/<project>/` | Error index and file tracker |
| `~/.clauditor/config.json` | Config |

## Limitations

- **Cannot reduce Claude Code's context assembly.** clauditor observes and advises; it does not modify what Claude Code sends to the API.
- **Cannot see quota.** Anthropic does not expose quota data. Token and cost figures are derived from the local JSONL.
- **The cache TTL is a stand-in.** `CACHE_TTL_MS` is 60 minutes because these sessions run on the 1-hour cache. Claude Code hands statusline scripts a real `prompt_cache.expires_at`; whether hook payloads carry it is unconfirmed.
- **A laptop that sleeps before the idle window loses the cache anyway.** The TTL is server-side wall-clock, so sleeping does not pause it.
- **A held socket message is invisible from outside.** If a session holds the woken bank request for an approval nobody is present to give, nothing happens. Every attempt is written to the activity log so the silence is auditable.
- **The messaging token is copied to disk** for the idle timer, at mode 0600 and deleted once the timer fires or is replaced. It is a longer-lived copy of a live secret than exists upstream.
- **Web sessions not supported.** Only CLI and IDE extensions write local JSONL files.
- **Per-device only.** Sessions do not sync across machines.

## Development

```bash
git clone https://github.com/netgearstephen/clauditor.git
cd clauditor
npm install
npm test        # 571 tests
npm run build
```

Tests never touch the real home directory and never wake a real session; `vitest.setup.ts` redirects `HOME` to a temp directory.

## Legal

MIT License. Not affiliated with or endorsed by Anthropic.

- No leaked source code was referenced or used
- All features derived from official docs, public community discussions, and independent observation
- "clauditor" = "Claude" + "auditor", used in a descriptive, nominative sense

## Contributing

Contributions welcome. Rules:

- **No leaked source code.** Do not reference or derive logic from non-public Anthropic code.
- **Attributable knowledge only.** Official docs, public GitHub issues, community posts, or independent observation.
- **Clean-room implementation.** If unsure about a knowledge source, don't contribute it.

## License

MIT
