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
}

const EMPTY_STATE: JournalState = {
  lastWriteAt: 0,
  lastFingerprint: '',
  bankedAt: 0,
  bankedAtTurn: 0,
  bankedSession: '',
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
 * spends a turn the user did not ask for. Once per SESSION, not per project:
 * the state file is keyed by directory, so testing bankedAt alone retires the
 * feature permanently after its first use in a repo.
 */
export function shouldBankHandoff(
  state: JournalState,
  peakContext: number,
  minPeakContext: number,
  transcriptPath: string | null,
  sessionId: string | null,
  now: number = Date.now()
): boolean {
  if (state.bankedAt > 0 && state.bankedSession === sessionId) return false
  if (peakContext < minPeakContext) return false
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
export function bankInstruction(peakContext: number): string {
  const k = peakContext.toLocaleString('en-GB')
  return (
    `clauditor: this session peaked at ${k} context tokens. The prompt cache is still ` +
    `warm, which makes this the cheapest moment in the session to write a handoff: that ` +
    `context reads back at 0.1x now, against the 2x a cold session would pay to rewrite ` +
    `it, so the same document costs roughly twenty times more once the cache expires.\n\n` +
    `Banking one now, so it is ready if and when you rotate. Nothing is being blocked and ` +
    `the session continues normally after this.\n\n` +
    `Start with a title line, exactly this shape and nothing above it:\n\n` +
    `# Handoff: <the task, as a short name>\n\n` +
    `That title names the file, so make it a name and not a sentence: under 60 ` +
    `characters, no trailing full stop, and specific enough to pick out of a list of ` +
    `many. "Wire clauditor into the handoff skill" is a name. "Two pieces of work, ` +
    `both complete" is not.\n\n` +
    `Then write ONLY the judgement half of a handoff, using these sections and no others:\n\n` +
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
 *
 * The trailing arguments are an options bag because sessionId and source are
 * both strings: passed positionally, one silently type-checks in the other's
 * slot.
 */
export function capturePendingHandoff(
  cwd: string | null,
  turns: number,
  message: string,
  {
    sessionId = null,
    source = 'banked',
    now = Date.now(),
  }: { sessionId?: string | null; source?: JudgementSource; now?: number } = {}
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
  writeJournalState(cwd, {
    ...state,
    bankedAt: now,
    bankedAtTurn: turns,
    bankedSession: sessionId ?? '',
    // A new session's bank supersedes the last one, so the previous
    // promotion must not keep promoteIfUsed from offering this one.
    promotedAt: 0,
  })
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
