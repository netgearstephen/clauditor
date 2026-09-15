import { logActivity } from '../features/activity-log.js'
import { readTurns, writeJournal } from '../features/journal.js'
import { readStdin, outputDecision, findTranscriptPathSync, isHookEntry } from './shared.js'

/**
 * PreCompact hook — fires right before Claude Code compacts the context.
 *
 * Compaction is about to discard older context, so the mechanical journal is
 * refreshed here whether or not it looks stale. Everything the journal reports
 * comes from git and the transcript rather than from the context window, so
 * nothing is actually lost by compaction, but this is free and the alternative
 * is a journal whose last write predates a boundary the user can see.
 */
export async function handlePreCompactHook(): Promise<void> {
  const input = await readStdin()
  let hookInput: { session_id: string; transcript_path?: string; cwd?: string }

  try {
    hookInput = JSON.parse(input)
  } catch {
    outputDecision({})
    return
  }

  try {
    const sessionId = hookInput.session_id
    const transcriptPath = hookInput.transcript_path || findTranscriptPathSync(sessionId)
    if (!transcriptPath) {
      outputDecision({})
      return
    }

    const { turns } = readTurns(transcriptPath)
    if (writeJournal(sessionId, hookInput.cwd || null, turns.length, { force: true })) {
      logActivity({
        type: 'context_warning',
        session: sessionId.slice(0, 8),
        message: 'PreCompact: refreshed the mechanical journal before compaction',
      }).catch(() => {})
    }
  } catch {
    // Non-critical
  }

  outputDecision({})
}

// Run only when this module is the entry point: see isHookEntry.
if (isHookEntry('pre-compact')) {
  handlePreCompactHook().catch((err) => {
    process.stderr.write(`clauditor pre-compact hook error: ${err}\n`)
    process.stdout.write('{}')
    process.exit(0)
  })
}
