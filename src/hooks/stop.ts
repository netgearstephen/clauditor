import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  StopHookInput,
  HookDecision,
  SessionRecord,
  AssistantRecord,
} from '../types.js'
import { createHash } from 'node:crypto'
import { logActivity } from '../features/activity-log.js'
import { readConfig } from '../config.js'
import {
  BANK_MARKER,
  adoptBankedHandoff,
  bankInstruction,
  capturePendingHandoff,
  handoffStamp,
  markBankRequested,
  readJournalState,
  recordBankRequest,
  readTurns,
  shouldBankHandoff,
  readSessionBank,
  peakContextTokens,
  writeJournal,
} from '../features/journal.js'
import {
  IDLE_BANK_DELAY_MS,
  isProcessAlive,
  readTimerFile,
  resolveClaudePid,
  sweepTimerFiles,
  writeTimerFile,
} from '../features/idle-watchdog.js'
import { readStdin, outputDecision, isHookEntry } from './shared.js'

/**
 * Stop hook handler.
 *
 * This is the session's single interruption point. It was one of four (a
 * SessionStart injection, a UserPromptSubmit block, a PostToolUse block and
 * this) writing two formats to two locations, which made it impossible to
 * know which one had produced any given file. The other three are gone.
 *
 * Three jobs, in order of how often they fire: keep the mechanical journal
 * current, bank the judgement half of a handoff once while the cache is warm,
 * and stop a compaction loop.
 */
export async function handleStopHook(): Promise<void> {
  let hookInput: StopHookInput
  try {
    const input = await readStdin()
    hookInput = JSON.parse(input) as StopHookInput
  } catch {
    outputDecision({})
    return
  }

  // Capture before the stop_hook_active guard, never after it. The reply we
  // asked for arrives on a re-entrant Stop, so capturing below the guard makes
  // the request every time and stores the answer never. A write, not a block.
  captureBankedHandoff(hookInput)

  // Armed here, not at the end: several paths below return early, including
  // the very next guard, on a re-entrant Stop. Arming placed after them would
  // never run on the one invocation shape a re-entrant loop always uses.
  armIdleTimer(hookInput)

  // If stop_hook_active is true, another stop hook is already running.
  // Do not block again to prevent infinite loops.
  if (hookInput.stop_hook_active) {
    outputDecision({})
    return
  }

  // Await all async hub pushes before outputDecision — process exits after stdout write
  await Promise.allSettled([
    pushSubagentSignals(hookInput),
    reportKnowledgeOutcomes(hookInput),
  ])

  // A loop is the more urgent of the two reasons to block, and blocking to
  // bank a handoff inside a loop would only add a turn to a session already
  // repeating itself.
  const loop = analyzeForLoop(hookInput)
  if (loop.decision === 'block') {
    outputDecision(loop)
    return
  }

  outputDecision(maintainSummary(hookInput) ?? {})
}

export function analyzeForLoop(input: StopHookInput): HookDecision {
  let records: SessionRecord[]
  try {
    const content = readFileSync(input.transcript_path, 'utf-8')
    records = content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean) as SessionRecord[]
  } catch {
    return {}
  }

  // Get the last N assistant records with tool calls
  const assistantRecords = records
    .filter((r): r is AssistantRecord => r.type === 'assistant')
    .slice(-6)

  if (assistantRecords.length < 3) return {}

  // Hash the tool calls from each turn
  const turnHashes = assistantRecords.map((record) => {
    const toolCalls = (record.message.content || [])
      .filter((block) => block.type === 'tool_use')
      .map((block) => `${block.name}:${hashValue(block.input)}`)
      .join('|')
    return toolCalls || ''
  })

  // Check for 3+ consecutive identical turn hashes
  let consecutiveCount = 1
  for (let i = turnHashes.length - 1; i > 0; i--) {
    if (turnHashes[i] && turnHashes[i] === turnHashes[i - 1]) {
      consecutiveCount++
    } else {
      break
    }
  }

  if (consecutiveCount >= 3) {
    // Identify what's looping
    const lastTools = assistantRecords[assistantRecords.length - 1].message.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => b.name)
      .join(', ')

    logActivity({
      type: 'loop_blocked',
      session: input.session_id.slice(0, 8),
      message: `Blocked loop — ${lastTools || 'tool'} call(s) repeated ${consecutiveCount}x with identical output`,
    }).catch(() => {})

    return {
      decision: 'block',
      reason:
        `Loop detected: same ${lastTools || 'tool'} call(s) failed ${consecutiveCount} times ` +
        'with identical output. Stopping to prevent token waste. ' +
        'Please review the error and try a different approach.',
    }
  }

  return {}
}

/**
 * Report knowledge outcomes — did the injected brief help?
 *
 * Simple heuristic: if the session didn't hit a loop (healthy),
 * all injected entries get a positive signal.
 */
async function reportKnowledgeOutcomes(input: StopHookInput): Promise<void> {
  if (input.stop_hook_active) return

  const cwd = extractCwd(input.transcript_path)
  if (!cwd) return

  try {
    const { reportOutcomes } = await import('../features/outcome-tracker.js')
    const reported = await reportOutcomes(input.session_id, cwd, true)
    if (reported > 0) {
      logActivity({
        type: 'notification',
        session: input.session_id.slice(0, 8),
        message: `Reported ${reported} positive outcomes for injected knowledge`,
      }).catch(() => {})
    }
  } catch (err) {
    process.stderr.write(`clauditor: outcome report failed: ${err instanceof Error ? err.message : err}\n`)
  }
}

/**
 * Push subagent metadata from the current session to the hub.
 * Reads .meta.json files for the session's subagents and sends
 * descriptions + categories. Fire-and-forget.
 */
async function pushSubagentSignals(input: StopHookInput): Promise<void> {
  const cwd = extractCwd(input.transcript_path)
  if (!cwd) return

  try {
    const { resolveHubContext } = await import('../hub/client.js')
    const hub = resolveHubContext(cwd)
    if (!hub) return

    const { scanSessionSubagents } = await import('../features/subagent-intel.js')
    const signals = scanSessionSubagents(cwd, input.session_id)
    if (signals.length === 0) return

    const { queueAndSend } = await import('../hub/push-queue.js')
    await queueAndSend(
      `${hub.config.url}/api/v1/subagents/sync`,
      { 'X-Clauditor-Key': hub.config.apiKey, 'Content-Type': 'application/json' },
      {
        project_hash: hub.projectHash,
        developer_hash: hub.config.developerHash,
        project_name: hub.remoteUrl,
        signals: signals.map(s => ({
          session_id: s.sessionId,
          agent_id: s.agentId,
          agent_type: s.agentType,
          description: s.description,
          category: s.category,
          files_touched: s.filesTouched,
          turn_count: s.turnCount,
        })),
      }
    )
  } catch (err) {
    process.stderr.write(`clauditor: subagent push failed: ${err instanceof Error ? err.message : err}\n`)
  }
}

/** Extract cwd from the last user record in the transcript. */
function extractCwd(transcriptPath: string): string | null {
  try {
    const content = readFileSync(transcriptPath, 'utf-8')
    const lines = content.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const r = JSON.parse(lines[i])
        if (r.type === 'user' && r.cwd) return r.cwd
      } catch {}
    }
  } catch {}
  return null
}

function hashValue(value: unknown): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return createHash('sha256').update(str).digest('hex').slice(0, 16)
}


// --- Two-mode session summary ---

/**
 * Keep the mechanical journal current, and bank the judgement half once, while
 * the cache is still warm enough to make it cheap.
 *
 * Returns a Stop decision when it wants Claude to write the judgement half,
 * otherwise null. That decision blocks the Stop event, not the user: it
 * appends one turn and the conversation carries on normally afterwards.
 */
function maintainSummary(input: StopHookInput): HookDecision | null {
  if (!input.transcript_path) return null

  const config = readConfig()
  if (!config.rotation.enabled) return null

  const cwd = extractCwd(input.transcript_path)
  const { turns } = readTurns(input.transcript_path)

  // The mechanical half. A script over git and the transcript, no model, so
  // it runs on every Stop that changed anything and costs nothing to keep
  // current.
  try {
    writeJournal(input.session_id, cwd, turns.length)
  } catch {}

  const state = readJournalState(cwd)
  const peakContext = peakContextTokens(turns)

  if (
    !shouldBankHandoff(
      state,
      peakContext,
      config.rotation.minPeakContext,
      input.transcript_path,
      input.session_id,
      { reBankGrowth: config.rotation.reBankGrowth }
    )
  ) {
    return null
  }

  logActivity({
    type: 'context_warning',
    session: input.session_id.slice(0, 8),
    message:
      `banking handoff at ${peakContext} peak context, ` +
      `${turns.length} turns, cache warm`,
  }).catch(() => {})

  // Stamped before the request goes out, so a file appearing afterwards is
  // known to be this request's answer.
  const requestedAt = Date.now()
  recordBankRequest(cwd, requestedAt, peakContext, input.session_id)
  // And stamped on the session's own marker, which is what lifts the wind-down
  // guard for the write this request is about to ask for. Without it the guard
  // refuses the Write named in the instruction below.
  markBankRequested(input.session_id, requestedAt)

  return {
    decision: 'block',
    reason: bankInstruction(peakContext, {
      stamp: handoffStamp(),
      // The session's OWN bank, never the per-directory state: that state
      // carries whatever the last session in this repo promoted, and passing
      // it here tells a session that has never banked to overwrite a document
      // it did not write. That destroyed a real handoff on 2026-09-10.
      rewritePath: readSessionBank(input.session_id)?.handoffPath ?? '',
    }),
  }
}

/**
 * Store the judgement half Claude just wrote in response to the bank request.
 *
 * The banked file stays in clauditor's own directory. It is promoted into the
 * user's handoffs directory only if a rotation actually happens, so that
 * directory never fills with machine-written handoffs nobody used.
 */
function captureBankedHandoff(input: StopHookInput): void {
  const msg = input.last_assistant_message
  if (!msg || !msg.includes(BANK_MARKER)) return
  if (!input.transcript_path) return

  const cwd = extractCwd(input.transcript_path)
  const { turns } = readTurns(input.transcript_path)

  // Preferred: the model wrote the document itself and replied with only the
  // prompt the user can paste. Falling back to the reply covers the turn where
  // the Write tool was not available, at the cost of the whole handoff
  // appearing in the terminal.
  const adopted = adoptBankedHandoff(cwd, turns.length, {
    sessionId: input.session_id,
    peakContext: peakContextTokens(turns),
    reply: msg,
  })
  if (adopted) {
    logActivity({
      type: 'context_warning',
      session: input.session_id.slice(0, 8),
      message: `banked handoff to ${adopted}`,
    }).catch(() => {})
    return
  }

  // The peak goes in with it: the marker it writes is what a re-bank measures
  // growth against, and a marker recording 0 is read as "banked before peaks
  // were recorded", which retires banking for the rest of the session.
  if (capturePendingHandoff(cwd, turns.length, msg, {
      sessionId: input.session_id,
      peakContext: peakContextTokens(turns),
    })) {
    logActivity({
      type: 'context_warning',
      session: input.session_id.slice(0, 8),
      message: `banked handoff judgement from the reply (${msg.length} chars)`,
    }).catch(() => {})
  }
}

/**
 * Push this session's idle timer out to 55 minutes from now.
 *
 * Cheap on every turn but the first: an existing, live poller is left running
 * and only `firesAt` is rewritten. Killing and respawning a node process per
 * turn would hold roughly 420MB across the sessions typically open here (42MB
 * a poller against 1.2MB for a shell sleeper, times the nine or ten sessions
 * typically open), and pay a spawn and a kill for nothing.
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

// Run only when this module is the entry point: see isHookEntry.
if (isHookEntry('stop')) {
  handleStopHook().catch((err) => {
    process.stderr.write(`clauditor stop hook error: ${err}\n`)
    // Output empty decision on error to avoid breaking Claude Code
    process.stdout.write('{}')
    process.exit(0)
  })
}
