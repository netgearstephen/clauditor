import { readErrorIndex, effectiveConfidence, confidenceTier } from './error-index.js'
import { readFileIndex } from './file-tracker.js'
import { offerSummary } from './journal.js'
import { statSync } from 'node:fs'

/**
 * Build a compact project brief from local knowledge.
 *
 * Assembles error index, file tracker, and recent session data into
 * a markdown brief (< 500 tokens) that gives Claude useful project
 * context at session start. No LLM, no network — pure local data.
 *
 * Returns null if there's nothing useful to inject.
 */
export function buildProjectBrief(cwd: string): string | null {
  const sections: string[] = []

  // Only inject knowledge that prevents concrete mistakes.
  // Hot file lists and session summaries don't meet this bar.
  // (Anthropic: "Would removing this cause Claude to make mistakes? If not, cut it.")
  const errorSection = buildErrorSection(cwd)
  if (errorSection) sections.push(errorSection)

  if (sections.length === 0) return null

  const brief = `[clauditor — project knowledge]:\n` + sections.join('\n\n')
  return brief.length > 2000 ? brief.slice(0, 2000) + '\n...' : brief
}

/**
 * Known errors — ranked by effective confidence (after decay), not raw occurrence count.
 * Shows confidence tier so Claude knows how much to trust each entry.
 */
function buildErrorSection(cwd: string): string | null {
  const errors = readErrorIndex(cwd)
  if (errors.length === 0) return null

  // Score and rank by effective confidence
  const scored = errors
    .map(e => ({
      ...e,
      effective: effectiveConfidence(e.confidence, e.lastSeen),
      tier: confidenceTier(effectiveConfidence(e.confidence, e.lastSeen)),
    }))
    .filter(e => e.effective >= 0.2) // skip stale
    .sort((a, b) => b.effective - a.effective)

  const withFixes = scored.filter(e => e.fix).slice(0, 5)
  const frequentUnfixed = scored.filter(e => !e.fix && e.effective >= 0.4).slice(0, 3)

  if (withFixes.length === 0 && frequentUnfixed.length === 0) return null

  const lines: string[] = ['## Known errors']

  for (const e of withFixes) {
    lines.push(
      `- \`${truncate(e.command, 60)}\`: ${truncate(e.error, 80)}` +
      `\n  Fix: \`${truncate(e.fix!, 80)}\` (${e.tier}, ${e.occurrences}x)`
    )
  }

  for (const e of frequentUnfixed) {
    lines.push(
      `- \`${truncate(e.command, 60)}\`: ${truncate(e.error, 80)} (${e.tier}, ${e.occurrences}x, no fix yet)`
    )
  }

  return lines.join('\n')
}

/**
 * Hot files — files with high edit counts across multiple sessions.
 */
function buildFileSection(cwd: string): string | null {
  const index = readFileIndex(cwd)
  const entries = Object.entries(index)
  if (entries.length === 0) return null

  const hot = entries
    .filter(([, e]) => e.editCount >= 3 && e.sessions >= 2)
    .sort(([, a], [, b]) => b.editCount - a.editCount)
    .slice(0, 8)

  if (hot.length === 0) return null

  const lines: string[] = ['## Active files']
  for (const [name, e] of hot) {
    lines.push(
      `- \`${name}\` — ${e.editCount} edits, ${e.sessions} sessions` +
      (e.lastEdited ? `, last ${e.lastEdited}` : '')
    )
  }

  return lines.join('\n')
}

/**
 * Recent work — extract a one-liner from the most recent session summary.
 */
function buildRecentSection(cwd: string): string | null {
  try {
    const summary = offerSummary(null, cwd)
    if (summary.kind === 'none' || !summary.content || !summary.path) return null

    // Prefer the Mission line: it is the one sentence in a handoff that says
    // what the session was for. Fall back to the first heading or bold line for
    // a mechanical journal, which has no Mission.
    const lines = summary.content.split('\n').filter((l) => l.trim().length > 0)
    const missionAt = lines.findIndex((l) => /^##\s+Mission\s*$/.test(l))
    const taskLine =
      (missionAt >= 0 ? lines[missionAt + 1] : undefined) ??
      lines.find((l) => l.startsWith('## ') || l.startsWith('**'))
    if (!taskLine) return null

    let timeStr = 'recently'
    try {
      const timeAgo = Math.round((Date.now() - statSync(summary.path).mtimeMs) / 60000)
      timeStr = timeAgo < 60 ? `${timeAgo}m ago` : `${Math.round(timeAgo / 60)}h ago`
    } catch {}

    return `## Last session (${timeStr})\n${truncate(taskLine.replace(/^[#*\s]+/, ''), 150)}`
  } catch {
    return null
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s
}
