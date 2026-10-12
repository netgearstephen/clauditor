import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { readJsonFile, writeJsonFileAtomic } from '../hooks/shared.js'

/**
 * Banking only happens at Stop, so one long autonomous turn can run far past
 * the gate with nothing banked. This asks the model to reach a stopping point
 * from inside the turn, so the next Stop does the bank.
 *
 * Once per gate crossing, then again only after `growth` more tokens, and not
 * at all while the session's own bank is still current.
 */
export function shouldNudgeRotation({
  context,
  gate,
  growth,
  nudgedAt,
  bankedPeak,
}: {
  context: number
  gate: number
  growth: number
  /** Context at this session's last nudge, 0 if none. */
  nudgedAt: number
  /** Context at this session's last bank, 0 if none. */
  bankedPeak: number
}): boolean {
  if (context < gate) return false
  if (bankedPeak > 0 && context < bankedPeak + growth) return false
  if (nudgedAt > 0 && context < nudgedAt + growth) return false
  return true
}

const NUDGE_FILE = resolve(homedir(), '.clauditor', 'rotation-nudge.json')

export function readNudgedAt(sessionId: string): number {
  return readJsonFile<Record<string, number>>(NUDGE_FILE, {})[sessionId] ?? 0
}

export function recordNudge(sessionId: string, context: number): void {
  const data = readJsonFile<Record<string, number>>(NUDGE_FILE, {})
  data[sessionId] = context
  try { writeJsonFileAtomic(NUDGE_FILE, data) } catch {}
}

export function rotationNudgeMessage(context: number, gate: number): string {
  return (
    `[clauditor — ROTATION DUE]: This session's context is ${Math.round(context / 1000)}k tokens, ` +
    `past the ${Math.round(gate / 1000)}k rotation trigger. A handoff can only be banked when your turn ends. ` +
    `Finish the step you are on (leave files compiling and tests in a known state), do not start the next ` +
    `sub-task, and end your turn with a short status for the user: what is done and what comes next. ` +
    `Clauditor will then bank a handoff so a fresh session can continue.`
  )
}
