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

  function run(
    hook: string,
    input: Record<string, unknown>,
    { herdr = false }: { herdr?: boolean } = {}
  ): Record<string, unknown> {
    // Pinned either way: this suite is itself often run from inside a herdr pane.
    const out = execFileSync('node', [hook], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      env: { ...process.env, HOME: home, HERDR_ENV: herdr ? '1' : '' },
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
  function markBanked(extra: Record<string, unknown> = {}): void {
    const dir = join(home, '.clauditor', 'banked')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${SESSION}.json`),
      JSON.stringify({
        bankedAt: Date.now(),
        cwd: CWD,
        peakContext: 210_000,
        handoffPath: '/tmp/h.md',
        ...extra,
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
    expect(out.reason).toContain('Tell them')
  }, 30_000)

  it('refuses the edits that would make the handoff stale', () => {
    markBanked()
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      expect(run(PRE_TOOL_USE, toolCall(tool)).decision).toBe('block')
    }
  }, 30_000)

  it('lets a subagent already at work finish it', () => {
    // A subagent's tool calls reach this hook under the parent's session_id,
    // so without this the bank refused work already in flight. Stephen: "That
    // hook and tooling is meant to wind down the subagents, not block them."
    // Claude Code sends agent_id only from inside a subagent, never from the
    // main thread, even in --agent sessions.
    markBanked()
    for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Task']) {
      const out = run(PRE_TOOL_USE, { ...toolCall(tool), agent_id: 'a1b2c3', agent_type: 'general-purpose' })
      expect(out.decision).toBeUndefined()
    }
    // agent_type alone is not a subagent: an --agent main thread carries it.
    expect(run(PRE_TOOL_USE, { ...toolCall('Edit'), agent_type: 'reviewer' }).decision).toBe('block')
  }, 30_000)

  it('lets a session answer the re-bank it was just asked for', () => {
    // The Stop hook stamps the marker when it asks for a re-bank. Refusing
    // Write here would make its own request unanswerable.
    markBanked({ bankRequestedAt: Date.now() + 1000 })
    for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
      expect(run(PRE_TOOL_USE, toolCall(tool)).decision).toBeUndefined()
    }
    // A new agent is still refused: no request has ever needed one.
    expect(run(PRE_TOOL_USE, toolCall('Task')).decision).toBe('block')
  }, 30_000)

  it('never refuses Bash, which is how the handoff gets updated', () => {
    markBanked()
    expect(run(PRE_TOOL_USE, toolCall('Bash')).decision).toBeUndefined()
  }, 30_000)

  it('lifts the block as soon as the user says anything at all', () => {
    // The user typing again IS the decision to carry on. A magic phrase only
    // ever caught out the person who had not memorised it. Stephen: "they
    // should just be able to prompt the conversation to keep going. Having a
    // specific phrase that is needed is stupid."
    markBanked()
    expect(run(PRE_TOOL_USE, toolCall('Task')).decision).toBe('block')

    const prompt = run(PROMPT, {
      session_id: SESSION,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'now do the other thing',
      cwd: CWD,
    })
    // The prompt hook blocks nothing, ever.
    expect(prompt).toEqual({})

    expect(run(PRE_TOOL_USE, toolCall('Task')).decision).toBeUndefined()
  }, 30_000)

  it('lifts the block on a bare continue, which is what people actually type', () => {
    markBanked()
    run(PROMPT, {
      session_id: SESSION,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'continue',
      cwd: CWD,
    })
    expect(run(PRE_TOOL_USE, toolCall('Task')).decision).toBeUndefined()
  }, 30_000)

  it('stays armed when the prompt is empty, which is not a person deciding anything', () => {
    markBanked()
    run(PROMPT, {
      session_id: SESSION,
      hook_event_name: 'UserPromptSubmit',
      prompt: '',
      cwd: CWD,
    })
    expect(run(PRE_TOOL_USE, toolCall('Task')).decision).toBe('block')
  }, 30_000)

  it('no longer names a phrase for the user to hunt for', () => {
    // The old message taught the incantation to whoever was blocked, which was
    // usually an agent. One relayed it, the hook read it out of the agent's own
    // message, and the guard came off with the user never having said a word.
    markBanked()
    const out = run(PRE_TOOL_USE, toolCall('Task'))
    expect(out.reason).not.toContain('clauditor continue')
    expect(out.reason).toContain('next message')
  }, 30_000)

  describe('handing itself over inside herdr', () => {
    function handoffWrite(tool: string): Record<string, unknown> {
      return {
        ...toolCall(tool),
        tool_input: { file_path: join(home, '.claude', 'handoffs', 'thing-20260923-2300.md') },
      }
    }

    function bash(command: string): Record<string, unknown> {
      return { ...toolCall('Bash'), tool_input: { command } }
    }

    it('lets every step of the succession through', () => {
      // Stephen: "I shouldn't have to intervene here."
      markBanked()
      expect(run(PRE_TOOL_USE, handoffWrite('Write'), { herdr: true }).decision).toBeUndefined()
      for (const command of [
        'herdr pane split --current --direction right --no-focus',
        'herdr agent start w5-next --kind claude --pane w5:pZ',
        'herdr agent prompt w5:pZ "Continue a paused task."',
        'herdr pane read --source recent --lines 80 --format text w5:pZ',
      ]) {
        expect(run(PRE_TOOL_USE, bash(command), { herdr: true }).decision).toBeUndefined()
      }
    }, 60_000)

    it('still refuses feature edits and new subagents', () => {
      markBanked()
      for (const tool of ['Task', 'Edit', 'Write', 'NotebookEdit']) {
        expect(run(PRE_TOOL_USE, toolCall(tool), { herdr: true }).decision).toBe('block')
      }
    }, 30_000)

    it('names the hand-over as the exception when it refuses', () => {
      markBanked()
      const out = run(PRE_TOOL_USE, toolCall('Edit'), { herdr: true })
      expect(out.reason).toContain('hand yourself over')
      expect(out.reason).toContain('herdr agent start')
      expect(out.reason).toContain('next message')
      // Stopping is for a session that is not handing over, not an order to all.
      expect(out.reason).toContain('If you are not handing over')
      expect(out.reason).not.toContain('Tell them')
    }, 30_000)

    it('keeps the refusal free of herdr outside it, where the session writes and stops', () => {
      markBanked()
      const out = run(PRE_TOOL_USE, toolCall('Edit'))
      expect(out.reason).not.toContain('herdr')
      expect(out.reason).toContain('Tell them')
      // The handoff itself may still be written, herdr or not.
      expect(run(PRE_TOOL_USE, handoffWrite('Write')).decision).toBeUndefined()
    }, 30_000)

    it('lets a session that has not banked work as it does today', () => {
      for (const tool of ['Task', 'Edit', 'Write']) {
        expect(run(PRE_TOOL_USE, toolCall(tool), { herdr: true }).decision).toBeUndefined()
      }
    }, 30_000)
  })

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
