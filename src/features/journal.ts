import {
  readFileSync,
  writeFileSync,
  renameSync,
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
import { contextTokens } from './cost-tracker.js'

/**
 * Two-mode session summary.
 *
 * A session gets ONE summary, produced one of two ways. The mechanical mode is
 * a script over git and the transcript: free, deterministic, rewritten
 * whenever the session moves. The augmented mode is the same facts plus
 * judgement (decisions and why, dead ends, gotchas) only the model can supply.
 *
 * They cannot drift: the augmented summary IS the mechanical one with
 * judgement spliced in, and both call the same script for the mechanical half.
 *
 * Judgement costs a model turn over the whole context, read at 0.1x warm and
 * rewritten at 2x cold. That 20x spread is why it is banked warm and never
 * regenerated cold, while the free mechanical half is regenerated at read time
 * rather than stored stale.
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
 *
 * This constant is a stand-in. Claude Code hands statusline scripts a real
 * `prompt_cache.expires_at` and `prompt_cache.ttl`, which would remove the
 * guess entirely, but whether hook payloads carry the same object is
 * unconfirmed. Confirm that before trusting this number further: it is
 * re-derived here rather than read from the source of truth.
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
  /** Session that banked it. State is per project, so banking once per
   * session means comparing this, not just testing bankedAt. */
  bankedSession: string
  /** Epoch ms the banked handoff was promoted into the user's directory. */
  promotedAt: number
  /** Epoch ms the bank was asked for, 0 if never. A handoff file newer than
   * this was written by the model answering that request, rather than left
   * over from an earlier one. */
  bankRequestedAt: number
  /** Peak context at the last bank. What growth since then is measured from. */
  bankedAtPeak: number
  /** Peak context when a bank was last asked for. An unanswered request is
   * held to the same growth rule as a completed one, so an interrupted or
   * declined request does not re-fire at every stop for the rest of the
   * session. */
  bankRequestedAtPeak: number
  /** Session the request was put to. The state file is per directory, so
   * without this a request left unanswered by one session would silence the
   * next session's bank in the same repo. */
  bankRequestedSession: string
  /** The handoff file the last bank produced. Re-banks overwrite it, so a
   * prompt the user pasted at the first bank keeps working. */
  promotedPath: string
}

const EMPTY_STATE: JournalState = {
  lastWriteAt: 0,
  lastFingerprint: '',
  bankedAt: 0,
  bankedAtTurn: 0,
  bankedSession: '',
  promotedAt: 0,
  bankRequestedAt: 0,
  bankedAtPeak: 0,
  bankRequestedAtPeak: 0,
  bankRequestedSession: '',
  promotedPath: '',
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
    // Written to one side and renamed into place, so a reader never catches a
    // half-written file. Rename is atomic within a directory; writing in place
    // is not.
    const tmp = `${statePath(cwd)}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2))
    renameSync(tmp, statePath(cwd))
  } catch {}
}

/** How long a lock is honoured before its holder is assumed to have died. */
const STATE_LOCK_STALE_MS = 5_000

/** How long an update waits for another session's lock before going ahead. */
const STATE_LOCK_WAIT_MS = 2_000

/** Block this thread. Hooks are synchronous, so there is nothing to await. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Apply a change to the journal state, reading it inside the lock that guards
 * the write.
 *
 * The state is per DIRECTORY, so two sessions working in one repo share it,
 * and every caller here is a read-modify-write: read the whole object, change
 * two fields, write the whole object back. Two of those interleaving lose one
 * session's fields entirely. Observed on 2026-09-10 in
 * `.../netgear-project-visibility/design/phase-1`, whose state ended up with
 * `bankedSession` naming one session, `bankedAtPeak` holding the other's peak,
 * `promotedPath` pointing at the first's document and `promotedAt` reset to 0.
 * An atomic write prevents a torn file, not a lost update; only holding the
 * read and the write together does that.
 *
 * A lock is never allowed to stop a write. If another session's lock is still
 * there after the wait, or was left behind by one that died, this goes ahead
 * anyway: a state file that is one field behind is a far smaller problem than
 * a hook that hangs on a stop.
 */
export function updateJournalState(
  cwd: string | null,
  mutate: (state: JournalState) => JournalState
): JournalState {
  const lock = `${statePath(cwd)}.lock`
  try {
    mkdirSync(journalDir(cwd), { recursive: true })
  } catch {}

  let held = false
  const deadline = Date.now() + STATE_LOCK_WAIT_MS
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' })
      held = true
      break
    } catch {}
    try {
      if (statSync(lock).mtimeMs < Date.now() - STATE_LOCK_STALE_MS) {
        unlinkSync(lock)
        continue
      }
    } catch {}
    if (Date.now() >= deadline) break
    sleepSync(25)
  }

  const next = mutate(readJournalState(cwd))
  writeJournalState(cwd, next)
  if (held) {
    try {
      unlinkSync(lock)
    } catch {}
  }
  return next
}

/**
 * One marker file per session that has paid for a bank.
 *
 * Keyed by session id rather than by directory, which is the whole point. The
 * journal state file lives under the encoded cwd, and a session that changes
 * directory mid-run reads a different one: it finds bankedAt 0, and banks a
 * second time for work it has already described. This ledger travels with the
 * session across every directory it visits.
 *
 * Free banks are deliberately absent from it. A compaction summary costs
 * nothing, so there is no turn to protect, and recording it here would leave a
 * repo the session moved into with no judgement at all.
 */
const BANKED_DIR = resolve(CLAUDITOR_DIR, 'banked')

/** How long a marker is kept. Long enough that no live session outlasts it. */
const BANK_MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Marker path for a session, or null if the id cannot be a filename. */
function bankMarkerPath(sessionId: string | null): string | null {
  if (!sessionId || !/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) return null
  return resolve(BANKED_DIR, `${sessionId}.json`)
}

/** What a session's bank marker records. */
export interface SessionBank {
  /** Epoch ms of the bank. */
  bankedAt: number
  /** Where the session was when it banked. */
  cwd: string | null
  /** Peak context at the bank, which growth since is measured from. */
  peakContext: number
  /** The handoff file it produced, so a re-bank can overwrite that one. */
  handoffPath: string
  /** Set once the user has explicitly asked to keep working in this session
   * after the bank. Absent on a fresh bank, so a re-bank re-arms the block. */
  continueAfterBank?: boolean
}

/** This session's bank, from any directory, or null if it has not banked. */
export function readSessionBank(sessionId: string | null): SessionBank | null {
  const path = bankMarkerPath(sessionId)
  if (!path) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    return {
      bankedAt: raw.bankedAt ?? 0,
      cwd: raw.cwd ?? null,
      peakContext: raw.peakContext ?? 0,
      handoffPath: raw.handoffPath ?? '',
      continueAfterBank: raw.continueAfterBank === true,
    }
  } catch {
    return null
  }
}

/** Has this session already paid for a bank, in any directory? */
export function hasSessionBanked(sessionId: string | null): boolean {
  return readSessionBank(sessionId) !== null
}

/** Record that this session has paid for a bank, and prune stale markers. */
export function markSessionBanked(
  sessionId: string | null,
  cwd: string | null,
  now: number = Date.now(),
  { peakContext = 0, handoffPath = '' }: { peakContext?: number; handoffPath?: string } = {}
): void {
  const path = bankMarkerPath(sessionId)
  if (!path) return
  try {
    mkdirSync(BANKED_DIR, { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({ bankedAt: now, cwd, peakContext, handoffPath }, null, 2)
    )
  } catch {
    return
  }
  try {
    for (const name of readdirSync(BANKED_DIR)) {
      const marker = resolve(BANKED_DIR, name)
      if (statSync(marker).mtimeMs < now - BANK_MARKER_TTL_MS) unlinkSync(marker)
    }
  } catch {}
}

/**
 * The tools that would make a banked handoff stale.
 *
 * A bank describes the session as it stood. Work that lands afterwards is work
 * the document does not mention, so a resuming session is told a story that has
 * already moved on. Dispatching a new agent is the worst case: its output
 * arrives long after the document was written and nothing records it.
 *
 * Bash is deliberately absent. Stephen: "Any work that needs to be done can be
 * added to the existing handoff if not already there - we won't block bash
 * calls to update that (if needed)." Reads are absent for the same reason:
 * looking at something changes nothing a handoff would have to describe.
 */
export const WORK_TOOLS_AFTER_BANK = ['Task', 'Edit', 'Write', 'NotebookEdit']

/**
 * Should this tool call be refused because the session has already banked?
 *
 * Keyed by session, never by directory, for the reason the whole ledger is:
 * a session that changes directory is still the same session, and a different
 * session in the same repo has its own handoff to protect.
 *
 * Agents already running are untouched. This gate sees only new calls, so work
 * in flight finishes and gets recorded, which is what the bank instruction's
 * `## In-flight agents` section is for.
 */
export function isBlockedAfterBank(sessionId: string | null, toolName: string): boolean {
  if (!WORK_TOOLS_AFTER_BANK.includes(toolName)) return false
  const bank = readSessionBank(sessionId)
  if (!bank) return false
  return bank.continueAfterBank !== true
}

/**
 * Record that the user has explicitly asked to carry on in this session.
 *
 * The bank's own fields are preserved: losing them would let the session bank
 * a second time for work it has already described.
 */
export function allowWorkAfterBank(sessionId: string | null): void {
  const path = bankMarkerPath(sessionId)
  const bank = readSessionBank(sessionId)
  if (!path || !bank) return
  try {
    writeFileSync(path, JSON.stringify({ ...bank, continueAfterBank: true }, null, 2))
  } catch {}
}

/**
 * Did the user explicitly ask to keep working after the bank?
 *
 * Deliberately narrow. A bare "continue" is ordinary encouragement and means
 * only "keep going with what you were doing"; lifting a guard on it would make
 * the guard meaningless. The phrase has to name clauditor or name the session.
 */
export function isExplicitContinue(prompt: string): boolean {
  return (
    /\bclauditor\b[\s,:—-]*continue\b/i.test(prompt) ||
    /\bcontinue\s+in\s+this\s+session\b/i.test(prompt)
  )
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
      const billed = contextTokens(usage)
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

  updateJournalState(cwd, (current) => ({
    ...current,
    lastWriteAt: now,
    lastFingerprint: fingerprint,
  }))
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
/**
 * The prompt the user pastes into a fresh session to resume.
 *
 * Stephen's own wording, from the /handoff skill, kept identical on purpose:
 * the two modes must be indistinguishable at the point of use, and this is
 * the point of use. `<path>` is the only thing substituted.
 */
export const PASTE_PROMPT =
  'Continue a paused task. Read `<path>` in full before doing anything else. ' +
  'Then summarise your understanding back to me in 3 to 5 bullets and confirm the very ' +
  'next step. Do not redo any work the file marks as complete. Do not modify anything ' +
  'listed under "Do not touch". Run the verification command first, and if its output ' +
  'does not match what the handoff records, stop and tell me the handoff is stale rather ' +
  'than guessing.'

/** Where a handoff with this title or mission line belongs on disk. */
export function handoffTarget(slug: string, now: Date = new Date()): string {
  const safeSlug =
    slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'session'
  return resolve(HANDOFFS_DIR, `${safeSlug}-${handoffStamp(now)}.md`)
}

/** Timestamp shape the handoff filenames use: YYYYMMDD-HHMM. */
export function handoffStamp(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`
  )
}

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
 * The largest context any single turn in the session was charged for.
 *
 * Peak rather than final, because a session that compacts drops back down
 * while the document a cold rewrite would have to reconstruct does not: the
 * saving is priced on the high-water mark. Cache writes count alongside reads
 * because both are context the model was billed to carry.
 */
export function peakContextTokens(turns: TurnMetrics[]): number {
  return turns.reduce((peak, t) => Math.max(peak, contextTokens(t.usage)), 0)
}

/**
 * Should the judgement half be banked now?
 *
 * Not the waste factor: that is last-five-turn cost over first-five, so it
 * falls below 1 as a session warms up and penalises the long well-behaved
 * sessions worth handing off. It answers whether to rotate, a different
 * question.
 *
 * Absolute for a non-obvious reason. Banking costs 0.1x the context and saves
 * the 2x a cold rewrite pays, so size cancels; it enters only because writing
 * costs a fixed ~3k output tokens at 5x, which is what makes a small session a
 * bad bet. Over 1,476 sessions and 87 handoffs, 200k needs an 8.0% reuse rate
 * against 17.6% observed, and is where that margin is widest.
 *
 * Warm because cold there is no saving left, and once per session because it
 * spends a turn the user did not ask for. Once per SESSION, not per project
 * and not per directory: the state file is keyed by the encoded cwd, so
 * testing bankedAt alone retires the feature permanently after its first use
 * in a repo, and testing bankedSession alone lets a session that moves
 * directory pay again. The session-keyed ledger answers it in both
 * directions.
 */
export function shouldBankHandoff(
  state: JournalState,
  peakContext: number,
  minPeakContext: number,
  transcriptPath: string | null,
  sessionId: string | null,
  {
    now = Date.now(),
    reBankGrowth = Number.POSITIVE_INFINITY,
  }: { now?: number; reBankGrowth?: number } = {}
): boolean {
  if (peakContext < minPeakContext) return false

  // Already banked, in this directory or any other. The one thing that earns a
  // second bank is the session having grown materially since: the document
  // describes the session as it stood, and work carried on the moment it was
  // written. A re-bank overwrites the same file rather than adding another.
  const bank = readSessionBank(sessionId)
  const bankedPeak = bank?.peakContext || state.bankedAtPeak || 0
  const banked = bank !== null || (state.bankedAt > 0 && state.bankedSession === sessionId)
  if (banked) {
    // A marker written before peaks were recorded cannot support the
    // comparison, so it is left as a plain "already banked".
    if (bankedPeak === 0) return false
    if (peakContext < bankedPeak + reBankGrowth) return false
  }

  // A request that was never answered counts too. The model normally answers,
  // because the request blocks the Stop event, but a user who interrupts
  // leaves it unanswered, and without this the request fires again at every
  // stop for the rest of the session. Held to the same growth rule, so a
  // session that has moved on a long way may ask once more.
  if (
    state.bankRequestedAt > 0 &&
    state.bankRequestedSession === sessionId &&
    peakContext < state.bankRequestedAtPeak + reBankGrowth
  ) {
    return false
  }

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
export function bankInstruction(
  peakContext: number,
  {
    stamp,
    rewritePath = '',
  }: { stamp: string; rewritePath?: string }
): string {
  const k = peakContext.toLocaleString('en-GB')

  // A re-bank has somewhere to go already: the file the first bank produced,
  // whose path the user may have pasted somewhere. A first bank does not, and
  // the name comes from a title only the model knows, so it is given the rule
  // and the timestamp rather than a finished path.
  const where = rewritePath
    ? `Overwrite this file, which your earlier bank in this session produced, so that a ` +
      `prompt already pasted from it keeps working:\n\n${rewritePath}\n\n`
    : `Write the handoff with the Write tool to:\n\n` +
      `${HANDOFFS_DIR}/<slug>-${stamp}.md\n\n` +
      `where <slug> is your title line in lower-case kebab-case, under 40 characters, and ` +
      `${stamp} is used exactly as given.\n\n`

  return (
    `clauditor: this session peaked at ${k} context tokens. The prompt cache is still ` +
    `warm, which makes this the cheapest moment in the session to write a handoff: that ` +
    `context reads back at 0.1x now, against the 2x a cold session would pay to rewrite ` +
    `it, so the same document costs roughly twenty times more once the cache expires.\n\n` +
    (rewritePath
      ? `You banked earlier in this session and have grown a long way since, so that ` +
        `document no longer describes where you are. Replacing it.\n\n`
      : `Banking one now, so it is ready if and when you rotate. Nothing is being blocked ` +
        `and the session continues normally after this.\n\n`) +
    where +
    `Then reply with EXACTLY this, on its own, with <path> replaced by the path you wrote ` +
    `and nothing else added:\n\n` +
    `${PASTE_PROMPT}\n\n` +
    `That is a prompt the user pastes into a fresh session, which is the only thing they ` +
    `need from you here. The handoff itself is a document to be read from disk later, so ` +
    `do not repeat any of its content in your reply. If the Write tool is not available to ` +
    `you on this turn, and only then, put the handoff in your reply instead.\n\n` +
    `Start the file with a title line, exactly this shape and nothing above it:\n\n` +
    `# Handoff: <the task, as a short name>\n\n` +
    `That title names the file, so make it a name and not a sentence: under 60 ` +
    `characters, no trailing full stop, and specific enough to pick out of a list of ` +
    `many. "Wire clauditor into the handoff skill" is a name. "Two pieces of work, ` +
    `both complete" is not.\n\n` +
    `Then write ONLY the judgement half of a handoff, using these sections and no others:\n\n` +
    JUDGEMENT_SECTIONS.map((s) => `## ${s}`).join('\n') +
    `\n\nIf background agents or subagents are still running, add one more section, ` +
    `## In-flight agents, naming each one, the task it was given, and how far it had got. ` +
    `That is the one thing a later session cannot recover: their work lands after this ` +
    `document is written. Record them and leave them running; do not stop them, and do ` +
    `not wait for them before writing.\n\n` +
    `Omit any section with no real content rather than stubbing it. Do NOT write a ` +
    `header block, Files touched, Required reading, or Verification command: those are ` +
    `derived mechanically at read time and anything you write there would be a second, ` +
    `staler copy.\n\n` +
    `Rules: declarative for state, imperative only for The very next step and Do not touch. ` +
    `Write "X is not yet implemented", never "implement X". Quote the user's own rationale ` +
    `where you can. British English, no em dashes. Absolute paths only.\n\n` +
    `Keep it under 12,000 bytes. Cut anything a Read of a cited path would tell the reader; ` +
    `cite the path instead. Never cut open questions, dead ends with their reason, gotchas, ` +
    `do-not-touch, or low confidence: those are what cannot be reconstructed.\n\n` +
    `End your reply with the marker ${BANK_MARKER} on its own line, then stop. The marker ` +
    `goes in the reply either way: it is how clauditor knows the request was answered. Do ` +
    `not put it in the file.`
  )
}

/**
 * Record that a bank has been asked for.
 *
 * Written before the request goes out, so that a handoff file appearing at the
 * pending path afterwards can be told apart from one left there by an earlier
 * bank. The directory is created at the same time: the model is about to be
 * asked to write into it.
 */
export function recordBankRequest(
  cwd: string | null,
  now: number = Date.now(),
  peakContext = 0,
  sessionId: string | null = null
): void {
  try {
    mkdirSync(journalDir(cwd), { recursive: true })
  } catch {}
  updateJournalState(cwd, (current) => ({
    ...current,
    bankRequestedAt: now,
    bankRequestedAtPeak: peakContext,
    bankRequestedSession: sessionId ?? '',
  }))
}

/**
 * Adopt the handoff the model wrote in answer to a bank request.
 *
 * The document goes straight into the user's own handoffs directory, rather
 * than waiting to be promoted when a later session resumes. That is what makes
 * the pasted prompt usable at the moment of banking: the path it names has to
 * exist, hold the complete document, and not move afterwards.
 *
 * Where it looks, in order: the path the reply names, the newest file in the
 * handoffs directory written since the request, and the clauditor-owned
 * pending path, which is where a model that ignored the instruction is likely
 * to have put it. Returns null if none of those produced a document, and the
 * caller falls back to capturing from the reply text.
 */
export function adoptBankedHandoff(
  cwd: string | null,
  turns: number,
  {
    sessionId = null,
    peakContext = 0,
    reply = '',
    now = Date.now(),
  }: {
    sessionId?: string | null
    peakContext?: number
    reply?: string
    now?: number
  } = {}
): string | null {
  const state = readJournalState(cwd)
  if (state.bankRequestedAt === 0) return null
  // The state is per directory, so the request it records can belong to a
  // different session: one that abandoned its request, or a state edited by
  // hand. Adopting on someone else's request is how a session came to
  // overwrite another session's banked document. An empty id is a state
  // written before the field existed, and stays adoptable.
  if (state.bankRequestedSession && state.bankRequestedSession !== sessionId) return null

  // A second of slack: the file is stamped by the filesystem, the request by
  // this process, and the two clocks need not agree to the millisecond.
  const since = state.bankRequestedAt - 1000
  const fresh = (path: string): boolean => {
    try {
      return statSync(path).mtimeMs >= since
    } catch {
      return false
    }
  }

  const candidates: string[] = []

  // The reply names the path the user is about to paste, so if that file is
  // there it is the one to keep, whatever else was written.
  for (const match of reply.matchAll(/`?(\/[^\s`'"]+\.md)`?/g)) {
    if (match[1].startsWith(HANDOFFS_DIR) && fresh(match[1])) candidates.push(match[1])
  }

  try {
    const written = readdirSync(HANDOFFS_DIR)
      .filter((n) => n.endsWith('.md'))
      .map((n) => resolve(HANDOFFS_DIR, n))
      .filter(fresh)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    candidates.push(...written)
  } catch {}

  if (fresh(pendingHandoffPath(cwd))) candidates.push(pendingHandoffPath(cwd))

  for (const candidate of candidates) {
    let raw: string
    try {
      raw = readFileSync(candidate, 'utf-8')
    } catch {
      continue
    }
    const judgement = stripPlumbing(raw)
    if (judgement.length < 100) continue
    if (belongsElsewhere(judgement, sessionId, cwd)) continue

    // A re-bank overwrites the file the first bank produced, so a prompt the
    // user has already pasted keeps naming the current document. A model that
    // wrote to clauditor's own path instead gets the document moved where the
    // user can find it, named from its title.
    // The recorded path is reused so a re-bank replaces the document the first
    // bank produced. It is only reused while it still describes this session:
    // a path left over from a bank that landed elsewhere would otherwise be
    // overwritten on every re-bank.
    const reusable =
      state.promotedPath !== '' && !belongsElsewhere(readIfPresent(state.promotedPath), sessionId, cwd)
    const target = reusable
      ? state.promotedPath
      : candidate.startsWith(HANDOFFS_DIR)
        ? candidate
        : handoffTarget(titleLine(judgement) ?? missionSlug(judgement), new Date(now))

    const assembled = mergeWithFacts(
      `<!-- judgement source: banked -->\n${judgement}`,
      sessionId,
      cwd
    )
    const document =
      cwd && !/\*\*Repo\*\*:/.test(assembled)
        ? `**Repo**: ${cwd}\n\n${assembled}`
        : assembled

    try {
      mkdirSync(HANDOFFS_DIR, { recursive: true })
      writeFileSync(target, document)
    } catch {
      continue
    }

    // Two documents describing one session diverge the moment either is
    // edited, so anything the adoption did not keep is removed.
    for (const stale of [candidate, pendingHandoffPath(cwd)]) {
      if (stale === target) continue
      try {
        unlinkSync(stale)
      } catch {}
    }

    updateJournalState(cwd, (current) => ({
      ...current,
      bankedAt: now,
      bankedAtTurn: turns,
      bankedSession: sessionId ?? '',
      bankedAtPeak: peakContext,
      promotedPath: target,
      // Already in the user's directory, so there is nothing left to promote.
      promotedAt: now,
    }))
    markSessionBanked(sessionId, cwd, now, { peakContext, handoffPath: target })
    return target
  }

  return null
}

/**
 * Does this document already declare itself another session's, or another
 * repo's? The handoffs directory is shared by every repo, so the newest file
 * written since the request need not be the one this session wrote: a second
 * session banking moments later would otherwise assemble its own mechanical
 * half on top of the first session's judgement.
 *
 * A document carrying neither header is the ordinary case, since the model
 * writes the judgement and the mechanical half is merged in afterwards.
 */
function belongsElsewhere(
  document: string,
  sessionId: string | null,
  cwd: string | null
): boolean {
  const session = /^\*\*Session\*\*:\s*(\S+)/m.exec(document)?.[1]
  if (session && sessionId && session !== sessionId) return true
  const repo = /^\*\*Repo\*\*:\s*(.+?)\s*$/m.exec(document)?.[1]
  if (repo && cwd && repo !== cwd) return true
  return false
}

/** A file's text, or empty when it cannot be read. */
function readIfPresent(path: string): string {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return ''
  }
}

/** Strip the hook-to-model plumbing out of a document a person will read. */
function stripPlumbing(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.includes(BANK_MARKER))
    .filter((l) => !/^<!--\s*judgement source:.*?-->\s*$/.test(l))
    .join('\n')
    .trim()
}

/**
 * Store Claude's banked judgement half, given the text of it.
 *
 * The marker line is stripped: it is plumbing between the hook and the model,
 * and has no business in a document a person reads. So is any provenance line
 * already present, which would otherwise accumulate one copy per adoption.
 *
 * The trailing arguments are an options bag because sessionId and source are
 * both strings: passed positionally, one silently type-checks in the other's
 * slot.
 */
function storeJudgement(
  cwd: string | null,
  turns: number,
  message: string,
  {
    sessionId = null,
    source = 'banked',
    peakContext = 0,
    now = Date.now(),
  }: {
    sessionId?: string | null
    source?: JudgementSource
    peakContext?: number
    now?: number
  } = {}
): boolean {
  const body = stripPlumbing(message)
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

  updateJournalState(cwd, (current) => ({
    ...current,
    bankedAt: now,
    bankedAtTurn: turns,
    bankedSession: sessionId ?? '',
    // A new session's bank supersedes the last one, so the previous
    // promotion must not keep promoteIfUsed from offering this one.
    promotedAt: 0,
  }))

  // Only a paid bank is recorded: see BANKED_DIR.
  //
  // The pending path is this bank's document, and recording it is what makes a
  // re-bank overwrite that file rather than write a second one. A marker left
  // with an empty path hands bankInstruction no rewritePath, and the prompt the
  // user has already pasted goes quietly stale.
  if (source === 'banked')
    markSessionBanked(sessionId, cwd, now, {
      peakContext,
      handoffPath: pendingHandoffPath(cwd),
    })
  return true
}

/**
 * Store a judgement half that arrived in the assistant's reply.
 *
 * The fallback to adoptWrittenHandoff, and the only route for a compaction
 * summary, which is handed to us as text and was never a file.
 */
export function capturePendingHandoff(
  cwd: string | null,
  turns: number,
  message: string,
  opts: {
    sessionId?: string | null
    source?: JudgementSource
    peakContext?: number
    now?: number
  } = {}
): boolean {
  return storeJudgement(cwd, turns, message, opts)
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

  // At read time the banking session is the authority: assembly runs in a
  // later session whose own transcript holds none of this work. The passed id
  // is the fallback for state banked before the field existed.
  const state = readJournalState(cwd)
  return mergeWithFacts(judgement, state.bankedSession || sessionId, cwd)
}

/**
 * Put the mechanical half into a judgement document.
 *
 * Shared by the two routes that need it: assembly at read time, and banking,
 * which now merges immediately because the file it produces is one the user
 * may paste a prompt for straight away. A document with no facts cannot
 * answer "run the verification command first".
 */
export function mergeWithFacts(
  judgement: string,
  sessionId: string | null,
  cwd: string | null
): string {
  // The id is used exactly as given, and resolving which id that should be is
  // the caller's job. This function used to prefer state.bankedSession, which
  // is right at read time and wrong at bank time: the state still describes
  // the PREVIOUS session's bank, so a freshly banked document was given the
  // last session's files, reads and commits under a correct judgement half.
  let facts = runFactsScript(sessionId, cwd)
  if (!facts) {
    try {
      facts = readFileSync(journalPath(cwd), 'utf-8').trim()
    } catch {
      facts = null
    }
  }
  if (!facts) return judgement

  // The order a hand-written handoff uses, so neither mode is recognisable as
  // the machine-written one. Title and provenance are lifted out of the stored
  // judgement: left in place they read as a missing section.
  const title = titleLine(judgement)
  const provenance = judgement.match(/^<!--\s*judgement source:.*?-->\s*$/m)?.[0] ?? null

  const body = judgement
    .replace(/^<!--\s*judgement source:.*?-->\s*$/m, '')
    .replace(/^#\s+Handoff:.*$/m, '')
    .trimStart()

  const head = [provenance, title ? `# Handoff: ${title}` : null]
    .filter(Boolean)
    .join('\n')

  return head ? `${head}\n\n${facts}\n\n${body}\n` : `${facts}\n\n${body}\n`
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

  // A handoff is matched back to its repo by this line, normally supplied by
  // the facts script. Promoted without it, nothing can ever find it again.
  if (cwd && !/\*\*Repo\*\*:/.test(assembled)) {
    assembled = `**Repo**: ${cwd}\n\n${assembled}`
  }

  const target = handoffTarget(slug, now)

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

  updateJournalState(cwd, (current) => ({ ...current, promotedAt: now.getTime() }))
  return target
}

/** The `# Handoff:` title line, if the judgement carries one. */
function titleLine(handoff: string): string | null {
  return handoff.match(/^#\s+Handoff:\s*(.+?)\s*$/m)?.[1] || null
}

/**
 * A name for the file.
 *
 * Prefers the title line, which is asked for precisely so that this does not
 * have to guess. Falls back to the first line of Mission, which produces a
 * poor name when that line is a sentence rather than a title, and is why the
 * title line exists.
 */
function missionSlug(handoff: string): string {
  const mission = handoff
    .split(/^## Mission\s*$/m)[1]
    ?.split(/^##\s/m)[0]
    ?.trim()
    .split('\n')[0]
  return titleLine(handoff) || mission || 'session'
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
