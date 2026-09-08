import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
  readdirSync,
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { TurnMetrics, TokenUsage } from '../types.js'

/**
 * Two-mode session summary.
 *
 * A session gets ONE summary, produced one of two ways. The mechanical mode
 * is a script over git and the transcript: free, deterministic, rewritten
 * whenever the session moves. The augmented mode is the same facts with a
 * layer of judgement (decisions and why, dead ends, gotchas) that only the
 * model can supply.
 *
 * The two are not alternatives that drift apart. The augmented summary IS the
 * mechanical one with judgement spliced in, and both call the same script for
 * the mechanical half, so there is no second implementation to fall behind.
 *
 * The judgement half is expensive: producing it costs a model turn over the
 * whole session context. What that turn costs depends entirely on whether the
 * prompt cache is still alive. Warm, the context is read at 0.1x. Cold, it is
 * rewritten at 2x. That is a 20x spread on the same work, so the judgement
 * half is banked while the cache is warm and never regenerated cold. The
 * mechanical half, being free, is regenerated at read time instead of stored
 * stale.
 */

const CLAUDITOR_DIR = resolve(homedir(), '.clauditor')
const JOURNALS_DIR = resolve(CLAUDITOR_DIR, 'journals')
const HANDOFFS_DIR = resolve(homedir(), '.claude', 'handoffs')

/** The shared mechanical extractor, owned by the /handoff skill. */
const FACTS_SCRIPT = resolve(
  homedir(),
  '.claude',
  'skills',
  'handoff',
  'scripts',
  'handoff-facts.py'
)

/**
 * Prompt cache TTL. Sessions here run on the 1-hour cache: measured across 400
 * sessions, dropping to 5m would save $354 on cheaper writes and lose $1,717
 * to expiry re-writes.
 */
export const CACHE_TTL_MS = 60 * 60 * 1000

/**
 * How stale the mechanical journal is allowed to get before it is rewritten
 * even though nothing detectably changed.
 *
 * This stands in for "write it before the cache expires", which cannot be done
 * directly: hooks fire on activity, and a cache dies during idleness, when by
 * definition no hook runs. There is no moment to predict from. Bounding
 * staleness gets the same guarantee from the other side. A prediction that
 * misfires leaves a stale journal at the one moment it is needed; a cap
 * cannot misfire, only cost a disk write.
 */
const STALENESS_CAP_MS = 15 * 60 * 1000

export interface JournalState {
  /** Epoch ms of the last mechanical journal write. */
  lastWriteAt: number
  /** Fingerprint of the session state at that write. */
  lastFingerprint: string
  /** Epoch ms the judgement half was banked, 0 if never. */
  bankedAt: number
  /** Turn count at which it was banked. */
  bankedAtTurn: number
  /** Epoch ms the banked handoff was promoted into the user's directory. */
  promotedAt: number
}

const EMPTY_STATE: JournalState = {
  lastWriteAt: 0,
  lastFingerprint: '',
  bankedAt: 0,
  bankedAtTurn: 0,
  promotedAt: 0,
}

/** Encode a cwd into a directory name. Mirrors session-state's encoding. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').slice(0, 100)
}

export function journalDir(cwd: string | null): string {
  return cwd ? resolve(JOURNALS_DIR, encodeCwd(cwd)) : JOURNALS_DIR
}

export function journalPath(cwd: string | null): string {
  return resolve(journalDir(cwd), 'current.md')
}

export function pendingHandoffPath(cwd: string | null): string {
  return resolve(journalDir(cwd), 'pending-handoff.md')
}

function statePath(cwd: string | null): string {
  return resolve(journalDir(cwd), 'state.json')
}

export function readJournalState(cwd: string | null): JournalState {
  try {
    return { ...EMPTY_STATE, ...JSON.parse(readFileSync(statePath(cwd), 'utf-8')) }
  } catch {
    return { ...EMPTY_STATE }
  }
}

export function writeJournalState(cwd: string | null, state: JournalState): void {
  try {
    mkdirSync(journalDir(cwd), { recursive: true })
    writeFileSync(statePath(cwd), JSON.stringify(state, null, 2))
  } catch {}
}

// --- Cache warmth ---

/**
 * Milliseconds since the session's last recorded turn, or null if unknown.
 *
 * The prompt cache is kept alive by use: each turn refreshes the TTL on the
 * prefix it reads. So the age of the last turn is the age of the cache.
 */
export function msSinceLastTurn(
  transcriptPath: string | null,
  now: number = Date.now()
): number | null {
  if (!transcriptPath) return null
  let content: string
  try {
    content = readFileSync(transcriptPath, 'utf-8')
  } catch {
    return null
  }
  const lines = content.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const r = JSON.parse(line)
      if (!r.timestamp) continue
      const t = Date.parse(r.timestamp)
      if (Number.isNaN(t)) continue
      return now - t
    } catch {}
  }
  return null
}

/**
 * Is the prompt cache still alive?
 *
 * Unknown counts as warm. Being wrong in that direction costs a cheap turn
 * that turns out not to have been cheap; being wrong the other way skips the
 * bank entirely and leaves the session with no augmented handoff at all.
 */
export function isCacheWarm(
  transcriptPath: string | null,
  now: number = Date.now()
): boolean {
  const age = msSinceLastTurn(transcriptPath, now)
  return age === null || age < CACHE_TTL_MS
}

/**
 * Turn-level usage and the model, read straight from the transcript.
 *
 * Deliberately minimal: everything else about a session that a summary needs
 * comes from the facts script, not from here.
 */
export function readTurns(transcriptPath: string): {
  turns: TurnMetrics[]
  model: string | null
} {
  const turns: TurnMetrics[] = []
  let model: string | null = null
  let content: string
  try {
    content = readFileSync(transcriptPath, 'utf-8')
  } catch {
    return { turns, model }
  }

  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (r.type !== 'assistant' || !r.message?.usage) continue
      if (!model && r.message?.model) model = r.message.model
      const u = r.message.usage
      const usage: TokenUsage = {
        input_tokens: u.input_tokens || 0,
        output_tokens: u.output_tokens || 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
        cache_read_input_tokens: u.cache_read_input_tokens || 0,
        cache_creation: u.cache_creation,
      }
      const billed =
        usage.input_tokens +
        usage.cache_creation_input_tokens +
        usage.cache_read_input_tokens
      turns.push({
        turnIndex: turns.length,
        timestamp: r.timestamp || '',
        usage,
        cacheRatio: billed > 0 ? usage.cache_read_input_tokens / billed : 0,
        toolCalls: [],
      })
    } catch {}
  }
  return { turns, model }
}

// --- Mechanical half ---

/**
 * Run the shared facts script.
 *
 * This is the same script the /handoff skill calls in its Step 1. Calling it
 * rather than reimplementing it is the whole reason the two modes cannot
 * disagree about what a file touched is.
 */
export function runFactsScript(
  sessionId: string | null,
  cwd: string | null
): string | null {
  if (!existsSync(FACTS_SCRIPT)) return null
  try {
    const args = [FACTS_SCRIPT]
    if (sessionId) args.push('--session-id', sessionId)
    return execFileSync('python3', args, {
      cwd: cwd || undefined,
      encoding: 'utf-8',
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    }).trim()
  } catch {
    return null
  }
}

/**
 * A cheap signature of everything the mechanical journal reports.
 *
 * Compared against the previous write to decide whether rewriting would
 * produce a different document. Turn count is included so that a session
 * that is thinking rather than editing still registers as having moved.
 */
export function fingerprintSession(cwd: string | null, turns: number): string {
  const git = (...args: string[]): string => {
    try {
      return execFileSync('git', args, {
        cwd: cwd || undefined,
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim()
    } catch {
      return ''
    }
  }
  return [
    turns,
    git('rev-parse', '--abbrev-ref', 'HEAD'),
    git('rev-parse', '--short', 'HEAD'),
    git('status', '--short'),
  ].join(' ')
}

/**
 * Should the mechanical journal be rewritten?
 *
 * Either the session moved, or the journal has been sitting long enough that
 * its age is itself a risk.
 */
export function shouldWriteJournal(
  state: JournalState,
  fingerprint: string,
  now: number = Date.now()
): boolean {
  if (state.lastWriteAt === 0) return true
  if (fingerprint !== state.lastFingerprint) return true
  return now - state.lastWriteAt >= STALENESS_CAP_MS
}

/**
 * Write the mechanical journal, returning true if it was written.
 *
 * Nothing here needs a model. If the facts script is unavailable the journal
 * is skipped rather than filled with a worse substitute: a summary that
 * quietly disagrees with the one /handoff produces is more damaging than no
 * summary, because only one of the two announces that it is missing.
 */
export function writeJournal(
  sessionId: string | null,
  cwd: string | null,
  turns: number,
  { force = false, now = Date.now() }: { force?: boolean; now?: number } = {}
): boolean {
  const fingerprint = fingerprintSession(cwd, turns)
  const state = readJournalState(cwd)
  if (!force && !shouldWriteJournal(state, fingerprint, now)) return false

  const facts = runFactsScript(sessionId, cwd)
  if (!facts) return false

  try {
    mkdirSync(journalDir(cwd), { recursive: true })
    writeFileSync(
      journalPath(cwd),
      `# Session journal (mechanical, by clauditor)\n\n${facts}\n`
    )
  } catch {
    return false
  }

  writeJournalState(cwd, {
    ...state,
    lastWriteAt: now,
    lastFingerprint: fingerprint,
  })
  return true
}

// --- Augmented half ---

/** Marker Claude appends so the Stop hook can recognise its own banked reply. */
export const BANK_MARKER = '[clauditor-banked-handoff]'

/**
 * Where a banked judgement came from.
 *
 * `banked` cost a model turn, deliberately spent while the cache was warm.
 * `compaction` cost nothing: Claude Code produces a summary of its own when it
 * compacts, written while the model still held the full context, and that is
 * judgement already paid for. Recorded because a reader deserves to know
 * whether they are looking at a document written to be handed over or a
 * by-product of compaction.
 */
export type JudgementSource = 'banked' | 'compaction'

/**
 * The judgement sections, in the order the /handoff skill writes them.
 *
 * The mechanical sections (header, Files touched, Required reading,
 * Verification command) are deliberately absent: those come from the script at
 * assembly time, so banking them would only create a second copy to go stale.
 */
const JUDGEMENT_SECTIONS = [
  'Mission',
  'Status snapshot',
  'Key decisions and why',
  'Dead ends',
  'Gotchas and constraints',
  'Open questions and blockers',
  'The very next step',
  'Do not touch',
  'Low confidence',
]

/**
 * Break-even turns for rotating, from the cost-weighted waste factor.
 *
 * T = 20 / (w - 1), where 20 is the write-to-read price ratio (2x against
 * 0.1x). Below w = 1 there is nothing to recover and rotation never pays.
 */
export function breakEvenTurns(wasteFactor: number): number | null {
  if (wasteFactor <= 1) return null
  return 20 / (wasteFactor - 1)
}

/**
 * Should the judgement half be banked now?
 *
 * Three conditions, all necessary. Rotation has to be worth doing at all, or
 * there is nothing for a handoff to enable. The cache has to be warm, because
 * banking cold costs roughly twenty times as much for the same document and
 * adds about 23 turns to the break-even rather than about one. And it has to
 * be unbanked, because this spends a turn the user did not ask for, so it
 * happens once per session and never again.
 */
export function shouldBankHandoff(
  state: JournalState,
  turns: number,
  wasteFactor: number,
  minTurns: number,
  wasteThreshold: number,
  transcriptPath: string | null,
  now: number = Date.now()
): boolean {
  if (state.bankedAt > 0) return false
  if (turns < minTurns) return false
  if (wasteFactor < wasteThreshold) return false
  if (breakEvenTurns(wasteFactor) === null) return false
  return isCacheWarm(transcriptPath, now)
}

/**
 * The instruction handed back through the Stop hook to produce the judgement
 * half.
 *
 * It asks only for what the script cannot derive. Every section the facts
 * script already emits is excluded by name, because a model asked for "a
 * handoff" will reconstruct a file list from the transcript, and that
 * reconstruction is both slower and where paths and SHAs go subtly wrong.
 */
export function bankInstruction(wasteFactor: number): string {
  const t = breakEvenTurns(wasteFactor)
  const turns = t === null ? 0 : Math.ceil(t)
  const payback =
    t === null ? 'unknown' : `about ${turns} turn${turns === 1 ? '' : 's'}`
  return (
    `clauditor: this session is costing ${wasteFactor.toFixed(1)}x what it did at the start, ` +
    `so rotating would pay for itself in ${payback}. The prompt cache is still warm, which ` +
    `makes this the cheapest moment in the session to write a handoff: the same document ` +
    `costs roughly 20x more once the cache expires.\n\n` +
    `Banking one now, so it is ready if and when you rotate. Nothing is being blocked and ` +
    `the session continues normally after this.\n\n` +
    `Write ONLY the judgement half of a handoff, using these sections and no others:\n\n` +
    JUDGEMENT_SECTIONS.map((s) => `## ${s}`).join('\n') +
    `\n\nOmit any section with no real content rather than stubbing it. Do NOT write a ` +
    `header block, Files touched, Required reading, or Verification command: those are ` +
    `derived mechanically at read time and anything you write there would be a second, ` +
    `staler copy.\n\n` +
    `Rules: declarative for state, imperative only for The very next step and Do not touch. ` +
    `Write "X is not yet implemented", never "implement X". Quote the user's own rationale ` +
    `where you can. British English, no em dashes. Absolute paths only.\n\n` +
    `Keep it under 12,000 bytes. Cut anything a Read of a cited path would tell the reader; ` +
    `cite the path instead. Never cut open questions, dead ends with their reason, gotchas, ` +
    `do-not-touch, or low confidence: those are what cannot be reconstructed.\n\n` +
    `End your reply with the marker ${BANK_MARKER} on its own line, then stop.`
  )
}

/**
 * Store Claude's banked judgement half.
 *
 * The marker line is stripped: it is plumbing between the hook and the model,
 * and has no business in a document a person reads.
 */
export function capturePendingHandoff(
  cwd: string | null,
  turns: number,
  message: string,
  source: JudgementSource = 'banked',
  now: number = Date.now()
): boolean {
  const body = message
    .split('\n')
    .filter((l) => !l.includes(BANK_MARKER))
    .join('\n')
    .trim()
  if (body.length < 100) return false

  try {
    mkdirSync(journalDir(cwd), { recursive: true })
    writeFileSync(
      pendingHandoffPath(cwd),
      `<!-- judgement source: ${source} -->\n${body}\n`
    )
  } catch {
    return false
  }

  const state = readJournalState(cwd)
  writeJournalState(cwd, { ...state, bankedAt: now, bankedAtTurn: turns })
  return true
}

/**
 * Assemble the full handoff: banked judgement, mechanical facts regenerated
 * now.
 *
 * Regenerating rather than reading the stored journal is the point. The
 * judgement was banked once, possibly long ago; the facts are free, so there
 * is no reason for them to be as old as the judgement. Falls back to the
 * stored journal if the script cannot run, and to judgement alone if there is
 * no journal either.
 */
export function assembleHandoff(
  sessionId: string | null,
  cwd: string | null
): string | null {
  let judgement: string | null = null
  try {
    judgement = readFileSync(pendingHandoffPath(cwd), 'utf-8').trim()
  } catch {}
  if (!judgement) return null

  let facts = runFactsScript(sessionId, cwd)
  if (!facts) {
    try {
      facts = readFileSync(journalPath(cwd), 'utf-8').trim()
    } catch {
      facts = null
    }
  }
  if (!facts) return judgement

  // Facts first: the header block belongs at the top of a handoff, and the
  // judgement sections read as commentary on the state it establishes.
  return `${facts}\n\n${judgement}\n`
}

/**
 * Promote the banked handoff into the user's own handoffs directory.
 *
 * This happens only when a rotation actually occurs. Until then the banked
 * file stays in clauditor's directory, so the directory the user browses for
 * real handoffs never fills up with machine-written ones that were never used.
 */
export function promoteHandoff(
  sessionId: string | null,
  cwd: string | null,
  slug?: string,
  now: Date = new Date()
): string | null {
  let assembled = assembleHandoff(sessionId, cwd)
  if (!assembled) return null
  slug = slug ?? missionSlug(assembled)

  // A handoff is matched back to its repo by this line. Assembly normally gets
  // it from the facts script, but if the script could not run the document
  // would be judgement alone, and a promoted handoff with no Repo line is one
  // nothing can ever find again.
  if (cwd && !/\*\*Repo\*\*:/.test(assembled)) {
    assembled = `**Repo**: ${cwd}\n\n${assembled}`
  }

  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`
  const safeSlug =
    slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'session'
  const target = resolve(HANDOFFS_DIR, `${safeSlug}-${stamp}.md`)

  try {
    mkdirSync(HANDOFFS_DIR, { recursive: true })
    writeFileSync(target, assembled)
  } catch {
    return null
  }

  // One copy, in one place. Leaving the banked file behind would mean two
  // documents claiming to describe the same session, diverging from the moment
  // the promoted one is edited.
  try {
    unlinkSync(pendingHandoffPath(cwd))
  } catch {}

  const state = readJournalState(cwd)
  writeJournalState(cwd, { ...state, promotedAt: now.getTime() })
  return target
}

/** First line of the Mission section, as a filename slug. */
function missionSlug(handoff: string): string {
  const mission = handoff
    .split(/^## Mission\s*$/m)[1]
    ?.split(/^##\s/m)[0]
    ?.trim()
    .split('\n')[0]
  return mission || 'session'
}

/**
 * Promote a banked handoff the first time a later session is offered it.
 *
 * Being offered to a new session is what "actually used" means here, and it is
 * the only point at which a machine-written handoff earns a place in the
 * directory the user browses. Guarded by state so a project resumed repeatedly
 * does not accumulate one copy per resume.
 */
export function promoteIfUsed(
  sessionId: string | null,
  cwd: string | null
): string | null {
  const state = readJournalState(cwd)
  if (state.bankedAt === 0 || state.promotedAt > 0) return null
  return promoteHandoff(sessionId, cwd)
}

// --- Consumption ---

export type SummaryKind = 'augmented' | 'mechanical' | 'none'

export interface OfferedSummary {
  kind: SummaryKind
  path: string | null
  content: string | null
}

/**
 * The one summary to offer a resuming session.
 *
 * Exactly one, never a menu. Judgement wins over no judgement, and between two
 * sources of judgement the newer one wins: a handoff the user wrote by hand
 * after the automatic bank supersedes it, and one written before it does not.
 * The mechanical journal is the floor, offered only when there is no judgement
 * anywhere.
 *
 * Note what is NOT compared: the mechanical journal's own timestamp. Assembly
 * regenerates the facts at read time, so a freshly written journal never makes
 * a banked handoff the staler of the two.
 */
export function offerSummary(
  sessionId: string | null,
  cwd: string | null
): OfferedSummary {
  const exists = (p: string): boolean => {
    try {
      return statSync(p).size > 0
    } catch {
      return false
    }
  }

  const pending = pendingHandoffPath(cwd)
  const pendingAt = exists(pending) ? statSync(pending).mtimeMs : 0
  const userHandoff = findUserHandoff(cwd)

  // A hand-written handoff already carries its own facts, so it is offered as
  // it stands rather than reassembled.
  if (userHandoff && userHandoff.mtimeMs >= pendingAt) {
    return {
      kind: 'augmented',
      path: userHandoff.path,
      content: userHandoff.content,
    }
  }

  if (pendingAt > 0) {
    const assembled = assembleHandoff(sessionId, cwd)
    if (assembled) {
      return { kind: 'augmented', path: pending, content: assembled }
    }
  }

  const journal = journalPath(cwd)
  if (exists(journal)) {
    try {
      return {
        kind: 'mechanical',
        path: journal,
        content: readFileSync(journal, 'utf-8'),
      }
    } catch {}
  }

  return { kind: 'none', path: null, content: null }
}

/**
 * The newest handoff in the user's own handoffs directory written for this
 * repo, or null.
 *
 * These are the handoffs the /handoff skill writes, plus any this module has
 * promoted. They are matched to a repo by the `**Repo**:` line in the header
 * block, which the facts script emits, rather than by filename: the slug is
 * derived from the mission line and says nothing reliable about the path.
 */
export function findUserHandoff(
  cwd: string | null,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  now: number = Date.now()
): { path: string; content: string; mtimeMs: number } | null {
  if (!cwd) return null

  let names: string[]
  try {
    names = readdirSync(HANDOFFS_DIR).filter((f) => f.endsWith('.md'))
  } catch {
    return null
  }

  let best: { path: string; content: string; mtimeMs: number } | null = null
  for (const name of names) {
    const path = resolve(HANDOFFS_DIR, name)
    try {
      const st = statSync(path)
      if (now - st.mtimeMs > maxAgeMs) continue
      if (best && st.mtimeMs <= best.mtimeMs) continue

      const content = readFileSync(path, 'utf-8')
      const repo = content.match(/\*\*Repo\*\*:\s*(.+)/)?.[1]?.trim()
      if (repo !== cwd) continue

      best = { path, content, mtimeMs: st.mtimeMs }
    } catch {}
  }
  return best
}
