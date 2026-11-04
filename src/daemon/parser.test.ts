import { describe, it, expect } from 'vitest'
import {
  parseJsonlLine,
  extractTurns,
  extractModel,
  extractSessionContext,
  aggregateUsage,
  TranscriptAccumulator,
} from './parser.js'
import { hasResumeBoundary } from '../features/resume-detector.js'
import type { AssistantRecord, UserRecord, ToolResultRecord, SessionRecord } from '../types.js'

describe('parseJsonlLine', () => {
  it('parses a user record', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: '2025-01-01T00:00:00Z',
      message: { role: 'user', content: 'hello' },
      cwd: '/tmp',
      version: '1.0',
    })
    const result = parseJsonlLine(line)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('user')
  })

  it('parses an assistant record', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      sessionId: 's1',
      timestamp: '2025-01-01T00:00:01Z',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'hi' }],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 0,
        },
      },
    })
    const result = parseJsonlLine(line) as AssistantRecord
    expect(result.type).toBe('assistant')
    expect(result.message.usage?.input_tokens).toBe(100)
  })

  it('returns null for empty lines', () => {
    expect(parseJsonlLine('')).toBeNull()
    expect(parseJsonlLine('   ')).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseJsonlLine('not json')).toBeNull()
  })

  it('accepts unknown record types (future-proof)', () => {
    const result = parseJsonlLine('{"type":"queue-operation"}')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('queue-operation')
  })

  it('returns null for records without a type field', () => {
    expect(parseJsonlLine('{"foo":"bar"}')).toBeNull()
  })

  it('parses compact_boundary records', () => {
    const line = JSON.stringify({ type: 'compact_boundary' })
    const result = parseJsonlLine(line)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('compact_boundary')
  })
})

describe('extractTurns', () => {
  function makeAssistant(
    turnIndex: number,
    usage: { input: number; output: number; cacheCreate: number; cacheRead: number },
    toolCalls: { name: string; input: unknown }[] = []
  ): AssistantRecord {
    return {
      type: 'assistant',
      uuid: `a${turnIndex}`,
      parentUuid: `u${turnIndex}`,
      sessionId: 's1',
      timestamp: `2025-01-01T00:0${turnIndex}:00Z`,
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [
          { type: 'text', text: 'response' },
          ...toolCalls.map((tc, i) => ({
            type: 'tool_use' as const,
            id: `tool_${turnIndex}_${i}`,
            name: tc.name,
            input: tc.input,
          })),
        ],
        usage: {
          input_tokens: usage.input,
          output_tokens: usage.output,
          cache_creation_input_tokens: usage.cacheCreate,
          cache_read_input_tokens: usage.cacheRead,
        },
      },
    }
  }

  it('carries the response id, so repeated records of one request can be priced once', () => {
    const a = makeAssistant(0, { input: 100, output: 50, cacheCreate: 200, cacheRead: 0 })
    const b = makeAssistant(1, { input: 100, output: 50, cacheCreate: 200, cacheRead: 0 })
    a.message.id = 'msg_1'
    b.message.id = 'msg_1'
    const turns = extractTurns([a, b, makeAssistant(2, { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 })])
    expect(turns.map((t) => t.messageId)).toEqual(['msg_1', 'msg_1', undefined])
  })

  it('extracts turns from assistant records', () => {
    const records: SessionRecord[] = [
      makeAssistant(0, { input: 100, output: 50, cacheCreate: 200, cacheRead: 0 }),
      makeAssistant(1, { input: 50, output: 80, cacheCreate: 100, cacheRead: 400 }),
    ]

    const turns = extractTurns(records)
    expect(turns).toHaveLength(2)
    expect(turns[0].turnIndex).toBe(0)
    expect(turns[0].cacheRatio).toBeCloseTo(0) // 0/(0+200+100)
    expect(turns[1].cacheRatio).toBeCloseTo(400 / 550) // 400/(400+100+50)
  })

  it('skips records without usage', () => {
    const records: SessionRecord[] = [
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2025-01-01T00:00:00Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'hi' }],
        },
      } as AssistantRecord,
    ]

    const turns = extractTurns(records)
    expect(turns).toHaveLength(0)
  })

  it('extracts tool call summaries', () => {
    const records: SessionRecord[] = [
      makeAssistant(
        0,
        { input: 100, output: 50, cacheCreate: 0, cacheRead: 0 },
        [{ name: 'Bash', input: { command: 'ls' } }]
      ),
    ]

    const turns = extractTurns(records)
    expect(turns[0].toolCalls).toHaveLength(1)
    expect(turns[0].toolCalls[0].name).toBe('Bash')
  })
  function toolResult(id: string, content: string): UserRecord {
    return {
      type: 'user', uuid: `r${id}`, parentUuid: null, sessionId: 's1', timestamp: '',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
    }
  }

  it('gives a repeated call the output of the latest identical call', () => {
    const records: SessionRecord[] = [
      makeAssistant(0, { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 }, [{ name: 'Bash', input: { command: 'ls' } }]),
      toolResult('tool_0_0', 'first'),
      makeAssistant(1, { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 }, [{ name: 'Bash', input: { command: 'ls' } }]),
      toolResult('tool_1_0', 'second'),
    ]
    const [first, second] = extractTurns(records)
    expect(first.toolCalls[0].outputHash).not.toBe('')
    expect(first.toolCalls[0].outputHash).toBe(second.toolCalls[0].outputHash)
    expect(first.toolCalls[0].outputHash).not.toBe(extractTurns(records.slice(0, 2))[0].toolCalls[0].outputHash)
  })
})

describe('TranscriptAccumulator', () => {
  it('matches a whole-array parse when records arrive in two batches', () => {
    const user: UserRecord = {
      type: 'user', uuid: 'u0', parentUuid: null, sessionId: 's1', timestamp: '',
      cwd: '/work/repo', gitBranch: 'main', message: { role: 'user', content: 'start here' },
    }
    const call: AssistantRecord = {
      type: 'assistant', uuid: 'a0', parentUuid: 'u0', sessionId: 's1', timestamp: 't0',
      message: {
        role: 'assistant', model: 'claude-opus-4-6',
        content: [{ type: 'tool_use', id: 'tool_a', name: 'Read', input: { file_path: '/x/y.ts' } }],
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
      },
    }
    const result: UserRecord = {
      type: 'user', uuid: 'u1', parentUuid: 'a0', sessionId: 's1', timestamp: '', gitBranch: 'feature',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_a', content: 'body' }] },
    }
    const records: SessionRecord[] = [user, call, { type: 'compact_boundary' }, result]

    const accumulator = new TranscriptAccumulator()
    accumulator.add(user)
    accumulator.add(call)
    expect(accumulator.getTurns()[0].toolCalls[0].outputHash).toBe('')
    accumulator.add({ type: 'compact_boundary' })
    accumulator.add(result)

    expect(accumulator.getTurns()).toEqual(extractTurns(records))
    expect(accumulator.getTurns()[0].toolCalls[0].outputHash).not.toBe('')
    expect(accumulator.getModel()).toBe(extractModel(records))
    expect(accumulator.getContext()).toEqual(extractSessionContext(records))
    expect(accumulator.getContext()).toEqual({
      cwd: '/work/repo', gitBranch: 'feature', projectName: 'repo', firstUserMessage: 'start here',
    })
    expect(accumulator.isResumed()).toBe(hasResumeBoundary(records))
  })
})

describe('aggregateUsage', () => {
  it('sums usage across turns', () => {
    const turns = [
      {
        turnIndex: 0,
        timestamp: '',
        cacheRatio: 0,
        toolCalls: [],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 0,
        },
      },
      {
        turnIndex: 1,
        timestamp: '',
        cacheRatio: 0.5,
        toolCalls: [],
        usage: {
          input_tokens: 50,
          output_tokens: 30,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 300,
        },
      },
    ]

    const total = aggregateUsage(turns)
    expect(total.input_tokens).toBe(150)
    expect(total.output_tokens).toBe(80)
    expect(total.cache_creation_input_tokens).toBe(300)
    expect(total.cache_read_input_tokens).toBe(300)
  })
})
