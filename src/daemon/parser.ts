import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type {
  SessionRecord,
  UserRecord,
  AssistantRecord,
  TokenUsage,
  TurnMetrics,
  ToolCallSummary,
} from '../types.js'

/**
 * Parse a single JSONL line into a typed record.
 * Returns null for unparseable or irrelevant lines.
 *
 * Real Claude Code JSONL files contain these record types:
 * - user, assistant: conversation messages
 * - system: system-level records
 * - queue-operation: internal queue ops
 * - attachment: file attachments
 * - summary, compact_boundary: compaction markers
 *
 * Tool results are embedded inside user messages as content blocks,
 * not as top-level records.
 */
export function parseJsonlLine(line: string): SessionRecord | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed.type) return null

    switch (parsed.type) {
      case 'user':
      case 'assistant':
      case 'system':
      case 'summary':
      case 'compact_boundary':
        return parsed as SessionRecord
      default:
        // Accept any record with a type field — future-proof
        return parsed as SessionRecord
    }
  } catch {
    return null
  }
}

/**
 * Yield a JSONL file's records one line at a time. `start` and `end` are
 * inclusive byte offsets, as for createReadStream.
 */
export async function* readJsonlRecords(
  filePath: string,
  range: { start?: number; end?: number } = {},
): AsyncGenerator<SessionRecord> {
  // Not readline: it also breaks lines at U+2028 and U+2029, which JSON
  // leaves unescaped inside strings, so it would split real records apart.
  let pending: string[] = []
  for await (const chunk of createReadStream(filePath, { encoding: 'utf-8', ...range })) {
    const text = chunk as string
    let from = 0
    for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', from)) {
      pending.push(text.slice(from, nl))
      const record = parseJsonlLine(pending.join(''))
      pending = []
      if (record) yield record
      from = nl + 1
    }
    if (from < text.length) pending.push(text.slice(from))
  }
  const last = parseJsonlLine(pending.join(''))
  if (last) yield last
}

/**
 * Parse an entire JSONL file into an array of records.
 */
export async function parseJsonlFile(filePath: string): Promise<SessionRecord[]> {
  const records: SessionRecord[] = []
  for await (const record of readJsonlRecords(filePath)) records.push(record)
  return records
}

/**
 * Builds a transcript's turns, model, context and resume flag one record at a
 * time, keeping hashes rather than records. Readers can be called again after
 * more records are added, which is how the watcher follows an appended file.
 */
export class TranscriptAccumulator {
  private turns: TurnMetrics[] = []
  private toolUses: { key: string; id: string }[] = []
  private resultHashes = new Map<string, string | null>()
  private model: string | null = null
  private cwd: string | null = null
  private gitBranch: string | null = null
  private firstUserMessage: string | null = null
  private resumed = false

  add(record: SessionRecord): void {
    if (record.type === 'compact_boundary' || record.type === 'summary') this.resumed = true
    if (record.type === 'assistant') this.addAssistant(record as AssistantRecord)
    else if (record.type === 'user') this.addUser(record as UserRecord)
    // Top-level tool_result is the spec's form; real transcripts embed results in user messages.
    else if (record.type === 'tool_result' && 'toolUseId' in record) {
      const tr = record as { toolUseId: string; content: unknown }
      this.resultHashes.set(tr.toolUseId, tr.content ? hashValue(tr.content) : null)
    }
  }

  getTurns(): TurnMetrics[] {
    // A call takes the result of the last same-named, same-input tool_use with
    // a result, which need not be its own block.
    const outputByKey = new Map<string, string>()
    for (const use of this.toolUses) {
      const hash = this.resultHashes.get(use.id)
      if (hash) outputByKey.set(use.key, hash)
    }
    return this.turns.map((turn) => ({
      ...turn,
      toolCalls: turn.toolCalls.map((call) => ({
        ...call,
        outputHash: outputByKey.get(toolKey(call.name, call.inputHash)) ?? '',
      })),
    }))
  }

  getModel(): string | null {
    return this.model
  }

  getContext(): SessionContext {
    return {
      cwd: this.cwd,
      gitBranch: this.gitBranch,
      projectName: projectNameOf(this.cwd),
      firstUserMessage: this.firstUserMessage,
    }
  }

  isResumed(): boolean {
    return this.resumed
  }

  private addAssistant(assistant: AssistantRecord): void {
    if (assistant.message?.model) this.model = assistant.message.model
    const content = Array.isArray(assistant.message?.content) ? assistant.message.content : []
    const toolCalls: ToolCallSummary[] = []
    for (const block of content) {
      if (block?.type !== 'tool_use') continue
      const inputHash = hashValue(block.input)
      if (typeof block.name === 'string' && block.id) {
        this.toolUses.push({ key: toolKey(block.name, inputHash), id: block.id })
      }
      toolCalls.push({
        name: block.name || 'unknown',
        inputHash,
        outputHash: '',
        inputLabel: extractInputLabel(block.name || '', block.input),
      })
    }

    if (!assistant.message?.usage) return
    const usage = normalizeUsage(assistant.message.usage)
    const totalInput =
      usage.input_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens

    this.turns.push({
      turnIndex: this.turns.length,
      timestamp: assistant.timestamp,
      usage,
      cacheRatio: totalInput > 0 ? usage.cache_read_input_tokens / totalInput : 0,
      toolCalls,
      messageId: assistant.message.id,
    })
  }

  private addUser(user: UserRecord): void {
    if (user.cwd) this.cwd = user.cwd
    if (user.gitBranch) this.gitBranch = user.gitBranch

    const content = user.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_result') {
          const toolBlock = block as Record<string, unknown>
          const toolUseId = toolBlock.tool_use_id as string
          if (toolUseId && toolBlock.content) this.resultHashes.set(toolUseId, hashValue(toolBlock.content))
        }
      }
    }

    if (!this.firstUserMessage) {
      const text = firstUserText(content)
      if (text !== null) this.firstUserMessage = text
    }
  }
}

/**
 * Extract turn metrics from a sequence of records.
 * A "turn" is defined as a user message followed by an assistant response.
 */
export function extractTurns(records: SessionRecord[]): TurnMetrics[] {
  const accumulator = new TranscriptAccumulator()
  for (const record of records) accumulator.add(record)
  return accumulator.getTurns()
}

/**
 * Aggregate total token usage across all turns.
 */
export function aggregateUsage(turns: TurnMetrics[]): TokenUsage {
  return turns.reduce(
    (acc, turn) => ({
      input_tokens: acc.input_tokens + turn.usage.input_tokens,
      output_tokens: acc.output_tokens + turn.usage.output_tokens,
      cache_creation_input_tokens:
        acc.cache_creation_input_tokens + turn.usage.cache_creation_input_tokens,
      cache_read_input_tokens:
        acc.cache_read_input_tokens + turn.usage.cache_read_input_tokens,
      cache_creation: {
        ephemeral_5m_input_tokens:
          (acc.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
          (turn.usage.cache_creation?.ephemeral_5m_input_tokens ?? 0),
        ephemeral_1h_input_tokens:
          (acc.cache_creation?.ephemeral_1h_input_tokens ?? 0) +
          (turn.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0),
      },
    }),
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 0,
      },
    } as TokenUsage
  )
}

/**
 * Extract the model ID from assistant records.
 * Uses the most recent assistant record's model field.
 */
export function extractModel(records: SessionRecord[]): string | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]
    if (record.type === 'assistant') {
      const assistant = record as AssistantRecord
      if (assistant.message?.model) {
        return assistant.message.model
      }
    }
  }
  return null
}

/**
 * Extract Claude Code version from session records.
 * Reads from user records which have a `version` field.
 */
export function extractVersion(records: SessionRecord[]): string | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]
    if (record.type === 'user' && 'version' in record) {
      const version = (record as { version?: string }).version
      if (version) return version
    }
  }
  return null
}

/**
 * Known buggy Claude Code version range: 2.1.69 - 2.1.89
 * These versions have a prompt caching bug (deferred tools break cache prefix matching)
 * that causes 10-20x token consumption. Fixed in v2.1.90+.
 */
export function isBuggyCacheVersion(version: string): boolean {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return false
  const [, major, minor, patch] = match.map(Number)
  if (major !== 2 || minor !== 1) return false
  return patch >= 69 && patch <= 89
}

export interface SessionContext {
  cwd: string | null
  gitBranch: string | null
  projectName: string | null
  firstUserMessage: string | null
}

/**
 * Extract human-readable session context from user records.
 * Pulls the working directory and git branch from the most recent
 * user record that has them.
 */
export function extractSessionContext(records: SessionRecord[]): SessionContext {
  let cwd: string | null = null
  let gitBranch: string | null = null

  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]
    if (record.type === 'user') {
      const user = record as UserRecord
      if (!cwd && user.cwd) cwd = user.cwd
      if (!gitBranch && user.gitBranch) gitBranch = user.gitBranch
      if (cwd && gitBranch) break
    }
  }

  let firstUserMessage: string | null = null
  for (const record of records) {
    if (record.type !== 'user') continue
    const text = firstUserText((record as UserRecord).message?.content)
    if (text !== null) firstUserMessage = text
    if (firstUserMessage) break
  }

  return { cwd, gitBranch, projectName: projectNameOf(cwd), firstUserMessage }
}

function projectNameOf(cwd: string | null): string | null {
  // Splits on both separators so Windows paths work too.
  return cwd ? cwd.split(/[/\\]/).filter(Boolean).pop() ?? null : null
}

/**
 * A user message's text, used to label subagents: a non-blank string, or the
 * first text block (even an empty one) of a block array. Null otherwise.
 */
function firstUserText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null
  if (!Array.isArray(content)) return null
  for (const block of content) {
    const b = block as Record<string, unknown> | null
    if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') return b.text.trim()
  }
  return null
}

function toolKey(name: string, inputHash: string): string {
  return `${name}\0${inputHash}`
}

/**
 * Extract a short readable label from a tool call input.
 */
function extractInputLabel(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>

  switch (toolName) {
    case 'Bash': {
      const cmd = typeof obj.command === 'string' ? obj.command : ''
      // Take first line, truncate to 60 chars
      return cmd.split('\n')[0].trim().slice(0, 60)
    }
    case 'Read':
    case 'Edit':
    case 'Write': {
      const fp = typeof obj.file_path === 'string' ? obj.file_path : ''
      return fp.split(/[/\\]/).pop() || ''
    }
    default:
      return ''
  }
}

function normalizeUsage(usage: Partial<TokenUsage>): TokenUsage {
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    // Per-TTL split of the write, needed to price it: 5m is 1.25x base, 1h 2x.
    cache_creation: usage.cache_creation,
  }
}

function hashValue(value: unknown): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return createHash('sha256').update(str).digest('hex').slice(0, 16)
}
