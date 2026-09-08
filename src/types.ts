// Core JSONL record types — derived from publicly observable Claude Code session file structure

export interface BaseRecord {
  type: string
  uuid?: string
  parentUuid?: string | null
  sessionId: string
  timestamp: string
  isSidechain?: boolean
}

export interface UserRecord extends BaseRecord {
  type: 'user'
  message: { role: 'user'; content: string | unknown[] }
  cwd?: string
  gitBranch?: string
  version?: string
}

export interface AssistantRecord extends BaseRecord {
  type: 'assistant'
  message: {
    role: 'assistant'
    model: string
    content: ContentBlock[]
    usage?: TokenUsage
  }
}

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  /**
   * Per-TTL split of cache_creation_input_tokens, emitted by Claude Code on
   * every assistant record. Absent it, a 1-hour write is billed at the
   * 5-minute rate and understated by 1.6x.
   */
  cache_creation?: CacheCreationBreakdown
}

export interface CacheCreationBreakdown {
  ephemeral_5m_input_tokens?: number
  ephemeral_1h_input_tokens?: number
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'thinking'
  text?: string
  id?: string
  name?: string
  input?: unknown
}

export interface ToolResultRecord extends BaseRecord {
  type: 'tool_result'
  toolUseId: string
  content: string
  durationMs?: number
}

export interface SummaryRecord {
  type: 'summary'
  leafUuid: string
  summary: string
}

export interface CompactBoundaryRecord {
  type: 'compact_boundary'
}

// Generic record for types we don't need to inspect deeply
export interface GenericRecord {
  type: string
  sessionId?: string
  timestamp?: string
  [key: string]: unknown
}

export type SessionRecord =
  | UserRecord
  | AssistantRecord
  | ToolResultRecord
  | SummaryRecord
  | CompactBoundaryRecord
  | GenericRecord

// Computed per-session state

export interface SessionState {
  sessionId: string
  projectPath: string
  filePath: string
  model: string | null
  label: string
  cwd: string | null
  gitBranch: string | null
  turns: TurnMetrics[]
  totalUsage: TokenUsage
  cacheHealth: CacheHealth
  loopState: LoopState
  resumeAnomaly: ResumeAnomaly
  quotaBurnRate: QuotaBurnRate
  lastUpdated: Date
}

export interface TurnMetrics {
  turnIndex: number
  timestamp: string
  usage: TokenUsage
  cacheRatio: number
  toolCalls: ToolCallSummary[]
}

export interface ToolCallSummary {
  name: string
  inputHash: string
  outputHash: string
  /** Short readable label — e.g. "npm test" for Bash commands */
  inputLabel?: string
}

export interface CacheHealth {
  status: 'healthy' | 'degraded' | 'broken' | 'unknown'
  lastCacheRatio: number
  cacheRatioTrend: number[]
  degradationDetected: boolean
}

export interface LoopState {
  loopDetected: boolean
  consecutiveIdenticalTurns: number
  loopPattern?: string
}

export interface ResumeAnomaly {
  detected: boolean
  resumeDetected: boolean
  outputTokenSpike: number | null
  cacheInvalidatedAfterResume: boolean
}

export interface QuotaBurnRate {
  tokensPerMinute: number
  estimatedMinutesRemaining: number | null
  burnRateStatus: 'normal' | 'elevated' | 'critical'
}

// Configuration

export interface ClauditorConfig {
  pricing: PricingConfig
  alerts: AlertConfig
  bashFilter: BashFilterConfig
  watch: WatchConfig
  rotation: RotationConfig
}

export interface PricingConfig {
  model: string
  inputPerMillion: number
  outputPerMillion: number
  /** 5-minute TTL cache write: 1.25x base input. */
  cacheCreationPerMillion: number
  /** 1-hour TTL cache write: 2x base input. Claude Code uses this TTL. */
  cacheCreation1hPerMillion: number
  cacheReadPerMillion: number
}

export interface AlertConfig {
  cacheBugThreshold: number
  loopDetectionThreshold: number
  claudeMdTokenWarning: number
  desktopNotifications: boolean
}

export interface BashFilterConfig {
  enabled: boolean
  maxOutputChars: number
  preservePatterns: string[]
  noisePatterns: string[]
}

export interface WatchConfig {
  projectsDir: string
  pollInterval: number
}

export interface RotationConfig {
  enabled: boolean
  writeToClaudeMd: boolean
  tokensPerTurnThreshold: number
  minTurns: number
}

// Hook I/O types

export interface StopHookInput {
  session_id: string
  transcript_path: string
  hook_event_name: 'Stop'
  stop_hook_active: boolean
  last_assistant_message: string
}

export interface PostToolUseHookInput {
  session_id: string
  hook_event_name: 'PostToolUse'
  tool_name: string
  tool_input: Record<string, unknown>
  tool_response: string
  cwd?: string
}

export interface PreToolUseHookInput {
  session_id: string
  hook_event_name: 'PreToolUse'
  tool_name: string
  tool_input: Record<string, unknown>
  cwd?: string
}

export interface HookDecision {
  decision?: 'block' | 'approve'
  reason?: string
  additionalContext?: string
}

// Model pricing table

export const MODEL_PRICING: Record<string, PricingConfig> = {
  'claude-fable-5-1': {
    model: 'claude-fable-5-1',
    inputPerMillion: 10.0,
    outputPerMillion: 50.0,
    cacheCreationPerMillion: 12.5,
    cacheCreation1hPerMillion: 20,
    cacheReadPerMillion: 0.25, // 0.025x - Fable 5.1 only
  },
  'claude-fable-5': {
    model: 'claude-fable-5',
    inputPerMillion: 10.0,
    outputPerMillion: 50.0,
    cacheCreationPerMillion: 12.5,
    cacheCreation1hPerMillion: 20,
    cacheReadPerMillion: 1.0,
  },
  'claude-opus-5': {
    model: 'claude-opus-5',
    inputPerMillion: 5.0,
    outputPerMillion: 25.0,
    cacheCreationPerMillion: 6.25,
    cacheCreation1hPerMillion: 10,
    cacheReadPerMillion: 0.5,
  },
  'claude-opus-4-8': {
    model: 'claude-opus-4-8',
    inputPerMillion: 5.0,
    outputPerMillion: 25.0,
    cacheCreationPerMillion: 6.25,
    cacheCreation1hPerMillion: 10,
    cacheReadPerMillion: 0.5,
  },
  'claude-opus-4-7': {
    model: 'claude-opus-4-7',
    inputPerMillion: 5.0,
    outputPerMillion: 25.0,
    cacheCreationPerMillion: 6.25,
    cacheCreation1hPerMillion: 10,
    cacheReadPerMillion: 0.5,
  },
  'claude-opus-4-6': {
    model: 'claude-opus-4-6',
    inputPerMillion: 5.0,
    outputPerMillion: 25.0,
    cacheCreationPerMillion: 6.25,
    cacheCreation1hPerMillion: 10,
    cacheReadPerMillion: 0.5,
  },
  'claude-sonnet-5': {
    model: 'claude-sonnet-5',
    inputPerMillion: 2.0,
    outputPerMillion: 10.0,
    cacheCreationPerMillion: 2.5,
    cacheCreation1hPerMillion: 4,
    cacheReadPerMillion: 0.2,
  },
  'claude-sonnet-4-6': {
    model: 'claude-sonnet-4-6',
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheCreationPerMillion: 3.75,
    cacheCreation1hPerMillion: 6,
    cacheReadPerMillion: 0.3,
  },
  'claude-haiku-4-5': {
    model: 'claude-haiku-4-5',
    inputPerMillion: 1.0,
    outputPerMillion: 5.0,
    cacheCreationPerMillion: 1.25,
    cacheCreation1hPerMillion: 2,
    cacheReadPerMillion: 0.1,
  },
}

/**
 * Fallback when a model ID matches nothing in MODEL_PRICING. Deliberately the
 * priciest entry: an unknown model is far more likely to be newer than older,
 * and over-reporting cost is a visible error where under-reporting is silent.
 */
export const FALLBACK_PRICING_MODEL = 'claude-fable-5-1'

export const DEFAULT_CONFIG: ClauditorConfig = {
  pricing: MODEL_PRICING['claude-opus-5'],
  alerts: {
    cacheBugThreshold: 3,
    loopDetectionThreshold: 3,
    claudeMdTokenWarning: 4000,
    desktopNotifications: true,
  },
  bashFilter: {
    enabled: true,
    maxOutputChars: 2000,
    preservePatterns: ['error', 'warn', 'fail', 'exception'],
    noisePatterns: ['npm warn', 'added \\d+ packages', '\\[=+'],
  },
  watch: {
    projectsDir: '~/.claude/projects',
    pollInterval: 1000,
  },
  rotation: {
    enabled: true,
    writeToClaudeMd: true,
    tokensPerTurnThreshold: 100_000,
    minTurns: 30,
  },
}
