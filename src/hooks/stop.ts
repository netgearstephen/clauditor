import { readFileSync } from 'node:fs'
import type {
  StopHookInput,
  HookDecision,
  SessionRecord,
  AssistantRecord,
  TurnMetrics,
  TokenUsage,
} from '../types.js'
import { createHash } from 'node:crypto'
import { logActivity } from '../features/activity-log.js'
import { readConfig } from '../config.js'
import { loadCalibration } from '../features/calibration.js'
import { sessionWasteFactor } from '../features/cost-tracker.js'
import {
  BANK_MARKER,
  bankInstruction,
  capturePendingHandoff,
  readJournalState,
  readTurns,
  shouldBankHandoff,
  writeJournal,
} from '../features/journal.js'
import { readStdin, outputDecision } from './shared.js'

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

  // Capture BEFORE the stop_hook_active guard, and never after it.
  //
  // The reply we asked for arrives on a re-entrant Stop: the previous
  // invocation blocked to request the handoff, Claude answered, and this
  // invocation is the one carrying that answer, which means stop_hook_active
  // is true. Capturing below the guard means the request is always made and
  // the answer is never stored. Capturing is a write and never a block, so it
  // is safe to run on a re-entrant invocation.
  captureBankedHandoff(hookInput)

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
  const { turns, model } = readTurns(input.transcript_path)

  // The mechanical half. A script over git and the transcript, no model, so
  // it runs on every Stop that changed anything and costs nothing to keep
  // current.
  try {
    writeJournal(input.session_id, cwd, turns.length)
  } catch {}

  const state = readJournalState(cwd)
  const cal = loadCalibration()
  const wasteFactor = sessionWasteFactor(turns, model)

  if (
    !shouldBankHandoff(
      state,
      turns.length,
      wasteFactor,
      cal.minTurns,
      cal.wasteThreshold,
      input.transcript_path
    )
  ) {
    return null
  }

  logActivity({
    type: 'context_warning',
    session: input.session_id.slice(0, 8),
    message:
      `banking handoff at ${wasteFactor.toFixed(1)}x waste, ` +
      `${turns.length} turns, cache warm`,
  }).catch(() => {})

  return { decision: 'block', reason: bankInstruction(wasteFactor) }
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

  if (capturePendingHandoff(cwd, turns.length, msg)) {
    logActivity({
      type: 'context_warning',
      session: input.session_id.slice(0, 8),
      message: `banked handoff judgement (${msg.length} chars)`,
    }).catch(() => {})
  }
}

// Run if invoked directly
handleStopHook().catch((err) => {
  process.stderr.write(`clauditor stop hook error: ${err}\n`)
  // Output empty decision on error to avoid breaking Claude Code
  process.stdout.write('{}')
  process.exit(0)
})
