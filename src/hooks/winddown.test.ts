import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

/**
 * End-to-end tests for the wind-down guard, run against the built hooks in a
 * subprocess with HOME redirected.
 *
 * Driven through the real entry points rather than the exported predicate,
 * because the predicate passing proves nothing about whether the hook is
 * wired to it: a unit-tested feature in this repo has already shipped inert
 * once for exactly that reason.
 */

const PRE_TOOL_USE = resolve(__dirname, '..', '..', 'dist', 'hooks', 'pre-tool-use.js')
const PROMPT = resolve(__dirname, '..', '..', 'dist', 'hooks', 'user-prompt-submit.js')
const CWD = '/home/user/project-a'
const SESSION = 'winddown-0001'

describe('winding down after a bank, end to end', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clauditor-winddown-e2e-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function run(hook: string, input: Record<string, unknown>): Record<string, unknown> {
    const out = execFileSync('node', [hook], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      env: { ...process.env, HOME: home },
      timeout: 30_000,
    })
    return JSON.parse(out || '{}')
  }

  function toolCall(tool: string): Record<string, unknown> {
    return {
      session_id: SESSION,
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: tool === 'Bash' ? { command: 'echo hi' } : { file_path: '/tmp/x' },
      cwd: CWD,
    }
  }

  /** Stand in for a bank this session has already paid for. */
  function markBanked(): void {
    const dir = join(home, '.clauditor', 'banked')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${SESSION}.json`),
      JSON.stringify({
        bankedAt: Date.now(),
        cwd: CWD,
        peakContext: 210_000,
        handoffPath: '/tmp/h.md',
      })
    )
  }

  it('lets everything through before the session has banked', () => {
    for (const tool of ['Task', 'Edit', 'Write', 'Bash']) {
      expect(run(PRE_TOOL_USE, toolCall(tool)).decision).toBeUndefined()
    }
  }, 30_000)

  it('refuses a new agent once the session has banked', () => {
    markBanked()
    const out = run(PRE_TOOL_USE, toolCall('Task'))
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('already banked')
    // The instruction the model needs, not just a refusal.
    expect(out.reason).toContain('do not start new ones')
    expect(out.reason).toContain('clauditor continue')
  }, 30_000)

  it('refuses the edits that would make the handoff stale', () => {
    markBanked()
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      expect(run(PRE_TOOL_USE, toolCall(tool)).decision).toBe('block')
    }
  }, 30_000)

  it('never refuses Bash, which is how the handoff gets updated', () => {
    markBanked()
    expect(run(PRE_TOOL_USE, toolCall('Bash')).decision).toBeUndefined()
  }, 30_000)

  it('lifts the block when the user explicitly says to continue', () => {
    markBanked()
    expect(run(PRE_TOOL_USE, toolCall('Task')).decision).toBe('block')

    const prompt = run(PROMPT, {
      session_id: SESSION,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'clauditor continue, I want to keep going',
      cwd: CWD,
    })
    // The prompt hook blocks nothing, ever.
    expect(prompt).toEqual({})

    expect(run(PRE_TOOL_USE, toolCall('Task')).decision).toBeUndefined()
  }, 30_000)

  it('does not lift the block on a bare continue', () => {
    markBanked()
    run(PROMPT, {
      session_id: SESSION,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'continue',
      cwd: CWD,
    })
    expect(run(PRE_TOOL_USE, toolCall('Task')).decision).toBe('block')
  }, 30_000)

  it('stays out of the way when the guard is switched off', () => {
    markBanked()
    mkdirSync(join(home, '.clauditor'), { recursive: true })
    writeFileSync(
      join(home, '.clauditor', 'config.json'),
      JSON.stringify({ rotation: { blockAfterBank: false } })
    )
    expect(run(PRE_TOOL_USE, toolCall('Task')).decision).toBeUndefined()
  }, 30_000)
})
