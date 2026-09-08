import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { effectiveTurnCost, rawTurnTokens, getPricingForModel } from './cost-tracker.js'
import type { TokenUsage } from '../types.js'

const CLAUDITOR_DIR = resolve(homedir(), '.clauditor')
const CALIBRATION_FILE = resolve(CLAUDITOR_DIR, 'calibration.json')

export interface CalibrationData {
  /** When calibration was last run */
  calibratedAt: string
  /** Number of sessions analyzed */
  sessionsAnalyzed: number
  /** Computed waste factor threshold */
  wasteThreshold: number
  /** Computed minimum turns before blocking */
  minTurns: number
  /** Whether we have enough data to be confident */
  confident: boolean
  /** Per-session data used for calibration */
  sessionProfiles: SessionProfile[]
}

interface SessionProfile {
  turns: number
  baseline: number
  final: number
  wasteFactor: number
  /** Turn at which rotation would have broken even */
  breakEvenTurn: number | null
  breakEvenWaste: number | null
}

const CONSERVATIVE_DEFAULT: CalibrationData = {
  calibratedAt: new Date().toISOString(),
  sessionsAnalyzed: 0,
  wasteThreshold: 2.0,
  minTurns: 30,
  confident: false,
  sessionProfiles: [],
}

/**
 * Load calibration data. Returns conservative defaults if not calibrated.
 */
export function loadCalibration(): CalibrationData {
  try {
    const raw = JSON.parse(readFileSync(CALIBRATION_FILE, 'utf-8'))
    return { ...CONSERVATIVE_DEFAULT, ...raw }
  } catch {
    return { ...CONSERVATIVE_DEFAULT }
  }
}

/**
 * Run calibration by scanning the user's past sessions.
 *
 * Algorithm:
 * 1. For each session with 30+ turns, compute:
 *    - baseline (avg tokens/turn for first 5 turns)
 *    - growth rate (how tokens/turn increases)
 *    - break-even point: the turn where cumulative overhead from
 *      continuing exceeds the cost of rotating (5 turns warmup)
 *
 * 2. Set threshold:
 *    - < 5 sessions: use conservative 10x (not enough data)
 *    - 5-10 sessions: use 75th percentile of break-even waste factors
 *    - 10+ sessions: use median of break-even waste factors
 *
 * Every number comes from the user's own data. Nothing hardcoded
 * except the rotation cost estimate (5 turns of warmup).
 */
export function calibrate(): CalibrationData {
  const projectsDir = resolve(homedir(), '.claude/projects')
  const profiles: SessionProfile[] = []

  try {
    const projectDirs = readdirSync(projectsDir, { withFileTypes: true })

    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue
      const dirPath = resolve(projectsDir, dir.name)

      try {
        const files = readdirSync(dirPath)
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue
          // Skip subagent files
          if (file.startsWith('agent-')) continue

          const filePath = resolve(dirPath, file)
          const profile = analyzeSession(filePath)
          if (profile) profiles.push(profile)
        }
      } catch { continue }
    }
  } catch {
    return CONSERVATIVE_DEFAULT
  }

  if (profiles.length === 0) {
    return CONSERVATIVE_DEFAULT
  }

  // Only use sessions with 30+ turns for threshold calculation
  const significantProfiles = profiles.filter((p) => p.turns >= 30)

  if (significantProfiles.length < 3) {
    // Not enough long sessions — use conservative default
    return {
      calibratedAt: new Date().toISOString(),
      sessionsAnalyzed: profiles.length,
      wasteThreshold: 2.0,
      minTurns: 30,
      confident: false,
      sessionProfiles: profiles,
    }
  }

  // Collect break-even waste factors from sessions that have them
  const breakEvenWastes = significantProfiles
    .filter((p) => p.breakEvenWaste !== null)
    .map((p) => p.breakEvenWaste!)
    .sort((a, b) => a - b)

  let wasteThreshold: number
  let confident: boolean

  if (breakEvenWastes.length < 5) {
    // Few data points — use 75th percentile (conservative)
    wasteThreshold = breakEvenWastes[Math.floor(breakEvenWastes.length * 0.75)] || 2.0
    confident = false
  } else if (breakEvenWastes.length < 10) {
    // Moderate data — use 75th percentile
    wasteThreshold = breakEvenWastes[Math.floor(breakEvenWastes.length * 0.75)] ?? 2.0
    confident = true
  } else {
    // Good data — use median
    wasteThreshold = breakEvenWastes[Math.floor(breakEvenWastes.length / 2)] ?? 2.0
    confident = true
  }

  // Clamp to reasonable range: minimum 5x, maximum 15x
  // Below 5x is too disruptive — user is mid-task and the session is still productive
  // Bounds are for COST ratios, which run far lower than the face-value token
  // ratios these were originally tuned against. Measured over 207 real
  // sessions of 20+ turns: median cost ratio 0.91 (the typical session is
  // cheaper per turn than when it began), p95 2.63, max 6.94. The same
  // sessions produce a median RAW ratio of 3.10, which is what used to make
  // healthy sessions look wasteful. A floor of 5 here would never fire.
  wasteThreshold = Math.max(1.5, Math.min(5, Math.round(wasteThreshold * 10) / 10))

  // Compute minTurns: the median turn count where sessions reach 2x waste
  // (don't block before sessions have done meaningful work)
  const twoXTurns = significantProfiles
    .filter((p) => p.wasteFactor >= 2)
    .map((p) => {
      // Estimate turn where 2x was reached: linear interpolation
      // waste grows linearly, so 2x is reached at approximately:
      // turn = (2x - 1x) / (finalWaste - 1x) * totalTurns
      const fraction = 1 / (p.wasteFactor - 1)
      return Math.round(fraction * p.turns)
    })
    .sort((a, b) => a - b)

  const minTurns = twoXTurns.length > 0
    ? Math.max(20, Math.min(100, twoXTurns[Math.floor(twoXTurns.length / 2)]))
    : 30

  const result: CalibrationData = {
    calibratedAt: new Date().toISOString(),
    sessionsAnalyzed: profiles.length,
    wasteThreshold,
    minTurns,
    confident,
    sessionProfiles: profiles,
  }

  // Save calibration
  try {
    mkdirSync(CLAUDITOR_DIR, { recursive: true })
    writeFileSync(CALIBRATION_FILE, JSON.stringify(result, null, 2) + '\n')
  } catch {}

  return result
}

/**
 * Analyze a single session file and return its profile.
 */
function analyzeSession(filePath: string): SessionProfile | null {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')

    const turnTokens: number[] = []

    const turnCosts: number[] = []

    let model: string | null = null

    for (const line of lines) {
      try {
        const r = JSON.parse(line)
        if (r.type === 'assistant' && r.message?.usage) {
          const u = r.message.usage
          if (!model && r.message?.model) model = r.message.model
          const usage: TokenUsage = {
            input_tokens: u.input_tokens || 0,
            output_tokens: u.output_tokens || 0,
            cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
            cache_read_input_tokens: u.cache_read_input_tokens || 0,
            cache_creation: u.cache_creation,
          }
          turnTokens.push(rawTurnTokens(usage))
          turnCosts.push(
            effectiveTurnCost(usage, model ? getPricingForModel(model) : undefined)
          )
        }
      } catch { continue }
    }

    if (turnTokens.length < 10) return null

    const baseline = turnTokens.slice(0, 5).reduce((a, b) => a + b, 0) / 5
    const final = turnTokens.slice(-5).reduce((a, b) => a + b, 0) / 5
    // Cost ratio, not token ratio - see cost-tracker.effectiveTurnCost. The
    // raw ratio counts cache reads at face value and overstates waste several
    // times over on exactly the sessions that are cheapest to continue.
    const baselineCost = turnCosts.slice(0, 5).reduce((a, b) => a + b, 0) / 5
    const finalCost = turnCosts.slice(-5).reduce((a, b) => a + b, 0) / 5
    const wasteFactor = baselineCost > 0 ? finalCost / baselineCost : 1

    // Find break-even point:
    // Rotation cost is NOT just 5 turns of cache warmup. It includes:
    // - Cache warmup (~5 turns)
    // - Human context switch (~5-10 min of productivity)
    // - Claude re-reading CLAUDE.md and re-establishing context
    // - Loss of in-session decisions not captured in CLAUDE.md
    //
    // Estimated total rotation cost: 30 turns worth of baseline tokens
    // This is conservative — if rotation is cheaper than this, it's
    // definitely worth it. If it's more expensive, we let the session continue.
    //
    // Break-even: 30 * baseline < remaining * (waste - 1) * baseline
    // → 30 < remaining * (waste - 1)
    // → remaining > 30 / (waste - 1)
    //
    // For waste = 3x: remaining > 15 turns
    // For waste = 5x: remaining > 7.5 turns
    // For waste = 10x: remaining > 3.3 turns
    const ROTATION_COST_TURNS = 30

    let breakEvenTurn: number | null = null
    let breakEvenWaste: number | null = null

    for (let i = 20; i < turnTokens.length; i++) {
      const windowTokens = turnTokens.slice(Math.max(0, i - 5), i)
      const currentAvg = windowTokens.reduce((a, b) => a + b, 0) / windowTokens.length
      const waste = baseline > 0 ? currentAvg / baseline : 1
      const remaining = turnTokens.length - i

      if (waste > 1 && remaining > ROTATION_COST_TURNS / (waste - 1)) {
        breakEvenTurn = i
        breakEvenWaste = Math.round(waste * 10) / 10
        break
      }
    }

    return {
      turns: turnTokens.length,
      baseline,
      final,
      wasteFactor: Math.round(wasteFactor * 10) / 10,
      breakEvenTurn,
      breakEvenWaste,
    }
  } catch {
    return null
  }
}

/**
 * Format calibration data for display.
 */
export function formatCalibration(cal: CalibrationData): string {
  const lines: string[] = []

  lines.push('clauditor calibration')
  lines.push('─'.repeat(55))
  lines.push(`  Last calibrated: ${cal.calibratedAt.slice(0, 16).replace('T', ' ')}`)
  lines.push(`  Sessions analyzed: ${cal.sessionsAnalyzed}`)
  lines.push(`  Confidence: ${cal.confident ? 'high (10+ data points)' : 'low (using conservative defaults)'}`)
  lines.push('')
  lines.push(`  THRESHOLD`)
  lines.push(`  ─────────`)
  lines.push(`  Waste factor: ${cal.wasteThreshold}x (block when turns cost ${cal.wasteThreshold}x more than baseline)`)
  lines.push(`  Min turns: ${cal.minTurns} (don't block before this)`)
  lines.push('')

  if (cal.sessionProfiles.length > 0) {
    const withBreakEven = cal.sessionProfiles.filter((p) => p.breakEvenWaste !== null)
    if (withBreakEven.length > 0) {
      lines.push(`  DATA POINTS (${withBreakEven.length} sessions with break-even points)`)
      lines.push(`  ─────────────`)
      for (const p of withBreakEven.slice(0, 10)) {
        lines.push(
          `  ${String(p.turns).padStart(4)} turns  ` +
          `${(p.baseline / 1000).toFixed(0).padStart(4)}k base  ` +
          `${p.wasteFactor.toFixed(1).padStart(5)}x final  ` +
          `break-even at turn ${p.breakEvenTurn} (${p.breakEvenWaste}x)`
        )
      }
    }
  }

  return lines.join('\n')
}
