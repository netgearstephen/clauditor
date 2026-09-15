import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { readdir, stat } from 'node:fs/promises'
import type { HookDecision } from '../types.js'
import { parseJsonlFile, extractTurns, extractModel } from '../daemon/parser.js'
import { detectCacheDegradation } from '../features/cache-health.js'
import { hasResumeBoundary, detectResumeAnomaly } from '../features/resume-detector.js'
import { logActivity } from '../features/activity-log.js'
import { readStdin, outputDecision, pruneStaleStateFiles, isHookEntry, findTranscriptPathSync } from './shared.js'

/**
 * SessionStart hook handler.
 *
 * Fires when Claude Code starts a new session. Checks recent session
 * history and injects context about:
 * - Previous session health issues
 * - Whether the last session was resumed (and if resume caused problems)
 * - Saved context from CLAUDE.md (reminds Claude to read it)
 *
 * This is infrastructure, not information — Claude acts on it automatically.
 */
export async function handleSessionStartHook(): Promise<void> {
  const input = await readStdin()
  let hookInput: { session_id: string; cwd?: string }
  try {
    hookInput = JSON.parse(input)
  } catch {
    outputDecision({})
    return
  }

  // Prune stale state files — lightweight, runs once per session start
  try { pruneStaleStateFiles() } catch {}

  const context = await buildSessionStartContext(hookInput.cwd, hookInput.session_id)
  outputDecision(context)
}

async function buildSessionStartContext(
  cwd?: string,
  sessionId?: string,
): Promise<HookDecision> {
  const parts: string[] = []
  // Goes to the user as systemMessage, so it is built outside the try and
  // returned separately from the model-facing parts.
  let advisory: string | null = null

  try {
    // Find recent sessions for this project
    const projectsDir = resolve(homedir(), '.claude/projects')
    const recentIssues = await checkRecentSessions(projectsDir)

    if (recentIssues.length > 0) {
      parts.push(
        `[clauditor — session health briefing]:\n` +
        `Before starting work, be aware of these issues from recent sessions:\n` +
        recentIssues.map((issue) => `  - ${issue}`).join('\n') +
        `\nIf the user is resuming a session with known issues, suggest starting fresh instead.`
      )
    }

    // Offer the previous session's summary. Exactly one, never a menu: a
    // resuming user is answering "is this the thing I was doing", which is a
    // yes or no, and the old numbered list of up to five full transcripts
    // spent thousands of tokens making them read four they did not want.
    const { offerSummary, promoteIfUsed } = await import('../features/journal.js')

    // A banked handoff being offered to a new session is the moment it gets
    // used, and the only point at which a machine-written one earns a place in
    // the user's own handoffs directory. Promote before offering, so what is
    // offered is the promoted copy and there is never more than one.
    try { promoteIfUsed(sessionId ?? null, cwd ?? null) } catch {}

    const summary = offerSummary(sessionId ?? null, cwd ?? null)

    // The handoff is advertised to the user, not injected into the model. It
    // used to arrive as additionalContext with an instruction to render an
    // offer and wait, which paid the whole entry cost and a model turn before
    // the user had said whether they wanted it. A systemMessage costs neither.
    if (summary.kind !== 'none' && summary.path) {
      const {
        readJournalState,
        readSessionBank,
        msSinceLastTurn,
        readTurns,
        recordHandoffOffered,
      } = await import('../features/journal.js')
      const { buildResumeAdvisory } = await import('../features/resume-advisory.js')

      // The figures come from the banking session's OWN marker, never from the
      // per-directory state. That state is shared by every session in the
      // directory and its fields are updated independently, so two sessions
      // banking in one directory leave it describing neither: observed live on
      // 2026-09-10, where bankedSession named one session and bankedAtPeak
      // held another's peak. The marker is per session and cannot mix them.
      //
      // Requiring the marker's own handoffPath to be the file being offered is
      // what keeps the peak, the age and the document describing one session.
      // Anything less certain falls through with no figures at all.
      const state = readJournalState(cwd ?? null)
      const bank = state.bankedSession ? readSessionBank(state.bankedSession) : null
      const paired = bank !== null && bank.handoffPath === summary.path && bank.peakContext > 0
      const transcript = paired ? findTranscriptPathSync(state.bankedSession) : null

      // Offered once, not to every session that opens this repo for the next
      // week. findUserHandoff has no notion of an offer having been made, so
      // without this the same document is pitched to unrelated new sessions
      // until its seven-day window closes: observed live on 2026-09-10, where
      // a handoff banked at 16:59 was still being offered the following day.
      //
      // Keyed on the path, so a newer handoff is a new offer. Recorded only
      // when an advisory was actually produced, because a warm-cache session
      // is shown nothing and must not consume the one offer.
      if (state.offeredPath !== summary.path) {
        advisory = buildResumeAdvisory({
          kind: summary.kind,
          path: summary.path,
          peakContext: paired ? bank.peakContext : 0,
          ageMs: transcript ? msSinceLastTurn(transcript) : null,
          model: (transcript ? readTurns(transcript).model : null) ?? undefined,
        })
        if (advisory) {
          try { recordHandoffOffered(cwd ?? null, summary.path) } catch {}
        }
      }
    }

    // Inject project knowledge brief (errors, hot files, recent context)
    if (cwd) {
      try {
        const { buildProjectBrief } = await import('../features/project-brief.js')
        const brief = buildProjectBrief(cwd)
        if (brief) parts.push(brief)
      } catch {
        // Non-critical — local knowledge not available yet
      }
    }

    // Sync auto-memory to hub + pull team knowledge (if configured)
    if (cwd) {
      try {
        const { resolveHubContext, pullCoreTier } = await import('../hub/client.js')
        const hub = resolveHubContext(cwd)
        if (hub) {
          // Flush any queued pushes from previous sessions (retry failed sends)
          try {
            const { flushQueue } = await import('../hub/push-queue.js')
            flushQueue().catch(() => {})
          } catch {}

          // Sync local auto-memory to hub (fire-and-forget)
          try {
            const { readAutoMemory, syncMemoryToHub } = await import('../hub/memory-sync.js')
            const memories = readAutoMemory(cwd)
            if (memories.length > 0) {
              syncMemoryToHub(memories, hub.projectHash, hub.config.developerHash, hub.config, hub.remoteUrl).catch(() => {})
            }
          } catch {}

          // Pull knowledge brief — top 5 things to know about this project
          try {
            const briefController = new AbortController()
            const briefTimeout = setTimeout(() => briefController.abort(), 5000)
            const briefRes = await fetch(
              `${hub.config.url}/api/v1/knowledge/brief?project_hash=${hub.projectHash}&max=5`,
              { headers: { 'X-Clauditor-Key': hub.config.apiKey }, signal: briefController.signal }
            )
            clearTimeout(briefTimeout)
            if (briefRes.ok) {
              const briefData = await briefRes.json() as {
                brief: Array<{ id: string | null; title: string; content: string; score: number; reason: string }>
              }
              if (briefData.brief?.length > 0) {
                const lines = briefData.brief.map((item, i) =>
                  `${i + 1}. ${item.title}\n   ${item.content.slice(0, 150).replace(/\n/g, ' ')}`
                )
                parts.push(
                  `[clauditor — what your team learned about this project]:\n` +
                  lines.join('\n\n')
                )

                // Record injected entry IDs for outcome tracking
                const entryIds = briefData.brief.map(b => b.id).filter((id): id is string => id !== null)
                if (entryIds.length > 0) {
                  try {
                    const { recordInjection } = await import('../features/outcome-tracker.js')
                    recordInjection(sessionId || 'unknown', entryIds)
                  } catch {}
                }
              }
            }
          } catch {}
        }
      } catch {
        // Hub unavailable — local knowledge is enough
      }
    }

    // CLAUDE.md reminder removed — Claude Code loads CLAUDE.md automatically.
    // Injecting a reminder wastes tokens without preventing mistakes.
    // Check for repeating workflows that could become skills
    const { SessionStore } = await import('../daemon/store.js')
    const { SessionWatcher } = await import('../daemon/watcher.js')
    const { detectWorkflowPatterns, generateSkillSuggestions, generateSubagentSkillSuggestions } = await import('../features/skill-suggest.js')

    const store = new SessionStore()
    const watcher = new SessionWatcher(store, { projectsDir })
    await watcher.scanAll()

    const sessions = store.getAll()
    const patterns = detectWorkflowPatterns(sessions)
    const suggestions = generateSkillSuggestions(patterns)

    // Also check subagent patterns for skill candidates
    if (cwd) {
      try {
        const { scanSubagents } = await import('../features/subagent-intel.js')
        const subagentSummary = scanSubagents(cwd)
        if (subagentSummary.total > 0) {
          const subagentSuggestions = generateSubagentSkillSuggestions(subagentSummary.signals)
          suggestions.push(...subagentSuggestions)
        }
      } catch {}
    }

    if (suggestions.length > 0) {
      // Only inject the top suggestion to avoid noise
      parts.push(suggestions[0].prompt)
    }
  } catch {
    // Non-critical
  }

  if (parts.length > 0) {
    logActivity({
      type: 'notification',
      session: 'startup',
      message: `Session start: injected briefing (${parts.length} items${parts.length > 1 ? ', includes skill suggestion' : ''})`,
    }).catch(() => {})
  }

  const decision: HookDecision = {}
  if (parts.length > 0) decision.additionalContext = parts.join('\n\n')
  if (advisory) decision.systemMessage = advisory
  return decision
}

/**
 * Scan recent sessions for health issues worth warning about.
 */
async function checkRecentSessions(projectsDir: string): Promise<string[]> {
  const issues: string[] = []
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000

  try {
    const projectDirs = await readdir(projectsDir, { withFileTypes: true })

    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue
      const projectPath = resolve(projectsDir, dir.name)

      try {
        const files = await readdir(projectPath)
        const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'))

        // Only check the 5 most recent files to keep startup fast
        const fileStats = await Promise.all(
          jsonlFiles.slice(0, 10).map(async (f) => {
            const fullPath = resolve(projectPath, f)
            try {
              const s = await stat(fullPath)
              return { path: fullPath, mtime: s.mtimeMs }
            } catch {
              return null
            }
          })
        )

        const recent = fileStats
          .filter((f): f is NonNullable<typeof f> => f !== null && f.mtime > oneDayAgo)
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 5)

        for (const file of recent) {
          try {
            const records = await parseJsonlFile(file.path)
            const turns = extractTurns(records)
            if (turns.length < 3) continue

            const cacheHealth = detectCacheDegradation(turns)
            if (cacheHealth.degradationDetected) {
              issues.push(
                `A recent session had broken cache (${(cacheHealth.lastCacheRatio * 100).toFixed(0)}% hit ratio). ` +
                `If resuming it, expect slow responses and high quota usage.`
              )
            }

            const isResumed = hasResumeBoundary(records)
            if (isResumed) {
              const anomaly = detectResumeAnomaly(turns, true)
              if (anomaly.detected) {
                issues.push(
                  `A recent resumed session had anomalies (${anomaly.outputTokenSpike ? 'token explosion' : 'cache invalidation'}). ` +
                  `Starting fresh is safer than resuming.`
                )
              }
            }
          } catch {
            continue
          }
        }
      } catch {
        continue
      }
    }
  } catch {
    // Projects dir may not exist
  }

  // Deduplicate and limit
  return [...new Set(issues)].slice(0, 3)
}

// Run only when this module is the entry point: see isHookEntry.
if (isHookEntry('session-start')) {
  handleSessionStartHook().catch((err) => {
    process.stderr.write(`clauditor session-start hook error: ${err}\n`)
    process.stdout.write('{}')
    process.exit(0)
  })
}
