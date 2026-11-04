import { SessionStore } from '../daemon/store.js'
import { SessionWatcher } from '../daemon/watcher.js'

export interface CacheIssue {
  label: string
  severity: 'broken' | 'degraded'
  turns: number
  cacheRatio: number
  trend: number[]
}

/**
 * Scan every transcript for cache degradation, one file at a time. Only the
 * session count and the issues outlive each file, so memory stays flat however
 * much history there is.
 */
export async function scanCacheIssues(options: {
  projectsDir: string
  projectPath?: string
}): Promise<{ sessions: number; issues: CacheIssue[] }> {
  const store = new SessionStore({ retain: false })
  let sessions = 0
  const issues: CacheIssue[] = []

  store.onUpdate((_sessionId, session) => {
    sessions++
    const { cacheHealth } = session
    const severity = cacheHealth.degradationDetected
      ? 'broken'
      : cacheHealth.status === 'degraded' ? 'degraded' : null
    if (!severity) return
    issues.push({
      label: session.label,
      severity,
      turns: session.turns.length,
      cacheRatio: cacheHealth.lastCacheRatio,
      trend: cacheHealth.cacheRatioTrend,
    })
  })

  await new SessionWatcher(store, options).scanAll()
  return { sessions, issues }
}
