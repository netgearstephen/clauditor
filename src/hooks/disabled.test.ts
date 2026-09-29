import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

/**
 * CLAUDITOR_DISABLED=1 turns every hook into a no-op for one session.
 *
 * Hooks from every settings source merge, so a caller launching unattended
 * sessions cannot drop clauditor's through --settings. It sets this variable
 * instead, and each hook must then exit 0 with nothing on stdout and nothing
 * written, so Claude Code sees no decision at all.
 */

const HOOKS = [
  'session-start',
  'user-prompt-submit',
  'pre-tool-use',
  'post-tool-use',
  'pre-compact',
  'post-compact',
  'stop',
  'session-end',
  'notification',
]

const CLI = resolve(__dirname, '..', '..', 'dist', 'cli.js')

describe('CLAUDITOR_DISABLED, through the CLI as configured', () => {
  let home: string
  let payload: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clauditor-disabled-'))
    const transcript = join(home, 't.jsonl')
    writeFileSync(
      transcript,
      JSON.stringify({ type: 'user', cwd: home, timestamp: new Date().toISOString() })
    )
    payload = JSON.stringify({
      session_id: 'disabled-probe',
      transcript_path: transcript,
      cwd: home,
      hook_event_name: 'PostToolUse',
      source: 'startup',
      tool_name: 'Write',
      tool_input: { file_path: join(home, 'x.md'), content: 'hi' },
      tool_response: {},
      prompt: 'hello',
    })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function run(name: string, disabled: string | undefined) {
    // Drop any inherited value, in case this suite itself runs under a caller
    // that sets it.
    const { CLAUDITOR_DISABLED: _, ...env } = process.env
    return spawnSync('node', [CLI, 'hook', name], {
      cwd: home,
      input: payload,
      encoding: 'utf-8',
      env: {
        ...env,
        HOME: home,
        CLAUDITOR_SOCK_DIR: join(home, 'no-cc-socks'),
        ...(disabled === undefined ? {} : { CLAUDITOR_DISABLED: disabled }),
      },
      timeout: 30_000,
    })
  }

  it.each(HOOKS)('%s exits 0, prints nothing and writes nothing when set to 1', (name) => {
    const result = run(name, '1')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(readdirSync(home)).toEqual(['t.jsonl'])
  }, 30_000)

  it('runs as normal when unset', () => {
    const result = run('post-tool-use', undefined)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('{}')
    expect(existsSync(join(home, '.clauditor'))).toBe(true)
  }, 30_000)

  it.each(['true', '0', ''])('runs as normal when set to %j, since only 1 counts', (value) => {
    const result = run('post-tool-use', value)
    expect(result.stdout).toBe('{}')
    expect(existsSync(join(home, '.clauditor'))).toBe(true)
  }, 30_000)
})
