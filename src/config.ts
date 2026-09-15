import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'

const CONFIG_DIR = resolve(homedir(), '.clauditor')
const CONFIG_FILE = resolve(CONFIG_DIR, 'config.json')

export interface ProjectHubConfig {
  apiKey: string
  url: string
  developerHash: string
  teamName?: string
  projectId?: string     // Hub project UUID — set during login project picker
  projectName?: string   // Friendly project name
  projectHash?: string   // Hub project hash — used in API calls
}

export interface ClauditorUserConfig {
  rotation: {
    enabled: boolean
    /**
     * Peak context tokens a session must reach before the judgement half is
     * banked. 200k is where the measured margin is widest: over 1,476 sessions
     * and 87 handoffs the required reuse rate is 8.0% against 17.6% observed,
     * while at 100k it is 9.1% against 10.2%.
     */
    minPeakContext: number
    /**
     * Peak-context growth since the last bank that makes the banked judgement
     * stale enough to be worth rewriting.
     *
     * A bank describes the session as it stood; work carries on immediately
     * afterwards, so the document is out of date from the moment it is
     * written.
     *
     * 50k, because 100k was above the drift it was meant to catch. Of the 321
     * sessions that cross the 200k gate, the median grows 72k more before it
     * ends, so at 100k the median banking session never refreshed at all and
     * the document it left behind was missing a third of the session's turns.
     * 50k refreshes 65% of them against 34% at 100k. The extra turn costs
     * about 0.2 x C + 37,000 units warm, which is the cheapest write in the
     * rotation and the only one that buys the document back from being stale.
     */
    reBankGrowth: number
    /**
     * After a session banks, refuse the tool calls that would make the banked
     * handoff stale. Agents already running are unaffected; Bash and reads
     * stay open so the handoff itself can still be updated.
     */
    blockAfterBank: boolean
  }
  notifications: {
    desktop: boolean
  }
  /** Per-project hub config, keyed by normalized git remote URL */
  projects?: Record<string, ProjectHubConfig>
}

const DEFAULTS: ClauditorUserConfig = {
  rotation: {
    enabled: true,
    minPeakContext: 200_000,
    reBankGrowth: 50_000,
    blockAfterBank: true,
  },
  notifications: {
    desktop: true,
  },
}

/**
 * Read config synchronously — safe for hooks (separate processes).
 * Falls back to defaults if file doesn't exist.
 */
export function readConfig(): ClauditorUserConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
    return {
      rotation: { ...DEFAULTS.rotation, ...raw.rotation },
      notifications: { ...DEFAULTS.notifications, ...raw.notifications },
      projects: raw.projects ? { ...raw.projects } : undefined,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/**
 * Get hub config for a specific project (by normalized git remote URL).
 */
export function getProjectHubConfig(gitRemoteUrl: string): ProjectHubConfig | null {
  const config = readConfig()
  return config.projects?.[gitRemoteUrl] ?? null
}

/**
 * Save hub config for a specific project.
 */
export function setProjectHubConfig(gitRemoteUrl: string, hubConfig: ProjectHubConfig): void {
  const config = readConfig()
  if (!config.projects) config.projects = {}
  config.projects[gitRemoteUrl] = hubConfig
  writeConfig(config)
}

/**
 * Write the full config to disk.
 */
export function writeConfig(config: ClauditorUserConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n')
}

/**
 * Write config. Only writes if file doesn't exist (preserves user edits).
 */
export function writeConfigIfMissing(): void {
  try {
    readFileSync(CONFIG_FILE)
    // File exists — don't overwrite
  } catch {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n')
  }
}
