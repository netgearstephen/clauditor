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

/** Per-model trigger override. Every field falls back to the top level. */
export interface ModelTriggerOverride {
  peakContext?: number
  buffer?: number
  minRequestsSinceBank?: number
}

export interface TriggerConfig {
  /**
   * Peak context tokens a session must reach before the judgement half is
   * banked.
   *
   * 150k. Measured over 1,392 sessions, steady-state cost per request is
   * minimised at a 138k trigger; 150k is 0.2% off that optimum where the
   * former 200k default was 4.9% off and 300k is 20.9% off. 150k also leaves
   * headroom below auto-compact.
   */
  peakContext: number
  /**
   * Fire this many tokens early. Zero by default.
   *
   * For anyone who wants the bank to land before the gate rather than on it,
   * without moving the gate itself and losing the number the measurements
   * were taken against.
   */
  buffer: number
  /**
   * Requests since the last bank before another one is allowed. Anti-thrash,
   * not a prediction.
   *
   * Applies to a re-bank only: a session that has never banked has nothing to
   * thrash against, and holding it back works against the gate.
   *
   * A "request" is one billed API request, which is what a turn is here, not
   * one user prompt: measured over this user's history a single prompt is a
   * mean of 26.6 and a median of 10 billed requests. The alternative
   * considered and rejected was an estimate of requests remaining, which is a
   * guess about the future and would be wrong on the sessions that matter
   * most.
   */
  minRequestsSinceBank: number
  /** Overrides keyed by the same longest-prefix model key as MODEL_PRICING. */
  perModel: Record<string, ModelTriggerOverride>
}

/** Per-model pricing override. Falls back to the top-level discount. */
export interface ModelPricingOverride {
  discount?: number
}

export interface PricingUserConfig {
  /**
   * Fraction off list price, 0 to 1. Zero by default, which is no discount.
   *
   * For enterprise agreements, so reported spend matches the invoice. It
   * changes reporting only and can never change a banking decision: a uniform
   * discount scales all five rate classes equally and cancels out of every
   * ratio the handover decision is made on.
   */
  discount: number
  /** Overrides keyed by the same longest-prefix model key as MODEL_PRICING. */
  perModel: Record<string, ModelPricingOverride>
}

export interface ClauditorUserConfig {
  rotation: {
    enabled: boolean
    /**
     * @deprecated Use `trigger.peakContext`. Kept because a legacy config
     * file that still sets this field is honoured through it, resolving as
     * if it had set trigger.peakContext instead. readConfig keeps the two
     * equal in both directions, so neither reader can go stale.
     */
    minPeakContext: number
    /** The layered gate that replaced minPeakContext. */
    trigger: TriggerConfig
    /**
     * Peak-context growth since the last bank that makes the banked judgement
     * stale enough to be worth rewriting.
     *
     * A bank describes the session as it stood; work carries on immediately
     * afterwards, so the document is out of date from the moment it is
     * written.
     *
     * 50k, because 100k was above the drift it was meant to catch. Measured
     * against the former 200k gate, not re-measured against the current 150k
     * default: of the 321 sessions that crossed 200k, the median grows 72k
     * more before it ends, so at 100k the median banking session never
     * refreshed at all and the document it left behind was missing a third
     * of the session's turns. 50k refreshes 65% of them against 34% at 100k.
     * The extra turn costs about 0.2 x C + 37,000 units warm, which is the
     * cheapest write in the rotation and the only one that buys the document
     * back from being stale.
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
  pricing: PricingUserConfig
  /** Per-project hub config, keyed by normalized git remote URL */
  projects?: Record<string, ProjectHubConfig>
}

const DEFAULTS: ClauditorUserConfig = {
  rotation: {
    enabled: true,
    minPeakContext: 150_000,
    trigger: {
      peakContext: 150_000,
      buffer: 0,
      minRequestsSinceBank: 20,
      perModel: {},
    },
    reBankGrowth: 50_000,
    blockAfterBank: true,
  },
  pricing: {
    discount: 0,
    perModel: {},
  },
  notifications: {
    desktop: true,
  },
}

/**
 * Read config synchronously, safe for hooks (separate processes).
 * Falls back to defaults if the file does not exist.
 */
export function readConfig(): ClauditorUserConfig {
  try {
    return mergeConfig(JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')))
  } catch {
    return mergeConfig({})
  }
}

/** Raw JSON from disk: every level optional, nothing trusted. */
type RawConfig = {
  rotation?: Partial<ClauditorUserConfig['rotation']>
  pricing?: Partial<PricingUserConfig>
  notifications?: Partial<ClauditorUserConfig['notifications']>
  projects?: ClauditorUserConfig['projects']
}

/**
 * Merge raw config over the defaults, two levels deep where it has to be.
 *
 * A one-level spread was enough until both new settings grew a nested
 * `perModel` map: a user setting a single override would arrive as the whole
 * parent object and take the sibling defaults out with it. The clone is not
 * incidental either. The old fallback returned a shallow copy of DEFAULTS,
 * which handed every caller the same nested objects to mutate.
 */
function mergeConfig(raw: RawConfig): ClauditorUserConfig {
  const rawRotation: Partial<ClauditorUserConfig['rotation']> = raw.rotation ?? {}
  const rawTrigger: Partial<TriggerConfig> = rawRotation.trigger ?? {}
  const rawPricing: Partial<PricingUserConfig> = raw.pricing ?? {}

  // The deprecated alias, resolved against the raw file rather than the
  // merged result: after merging there is no telling an explicit 200k from
  // the default, and the alias must not win over a default it predates.
  const aliased =
    rawTrigger.peakContext ?? rawRotation.minPeakContext ?? DEFAULTS.rotation.trigger.peakContext

  const trigger: TriggerConfig = {
    ...DEFAULTS.rotation.trigger,
    ...rawTrigger,
    peakContext: aliased,
    perModel: { ...DEFAULTS.rotation.trigger.perModel, ...(rawTrigger.perModel ?? {}) },
  }

  return {
    rotation: {
      ...DEFAULTS.rotation,
      ...rawRotation,
      trigger,
      // Kept equal to the trigger, so the readers still on the old name
      // cannot drift from the one that replaced it.
      minPeakContext: trigger.peakContext,
    },
    pricing: {
      ...DEFAULTS.pricing,
      ...rawPricing,
      perModel: { ...DEFAULTS.pricing.perModel, ...(rawPricing.perModel ?? {}) },
    },
    notifications: { ...DEFAULTS.notifications, ...raw.notifications },
    projects: raw.projects ? { ...raw.projects } : undefined,
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
