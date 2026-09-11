import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

/**
 * Every hook must put exactly one JSON object on stdout.
 *
 * Hook modules run themselves on import. The build bundles several into one
 * chunk, so importing one ran another, and `clauditor hook post-tool-use`
 * printed `{}{}`: Claude Code reported a hook error on every Write and Edit
 * for as long as that lasted. Nothing in the unit tests could see it, because
 * the fault was in the built entry points rather than in any handler.
 */

const HOOKS = [
  'post-compact',
  'post-tool-use',
  'pre-compact',
  'pre-tool-use',
  'session-start',
  'stop',
  'user-prompt-submit',
]

describe('hook stdout, end to end', () => {
  let home: string
  let payload: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clauditor-hook-out-'))
    const transcript = join(home, 't.jsonl')
    writeFileSync(
      transcript,
      JSON.stringify({ type: 'user', cwd: home, timestamp: new Date().toISOString() })
    )
    payload = JSON.stringify({
      session_id: 'hook-output-probe',
      transcript_path: transcript,
      cwd: home,
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(home, 'x.md'), content: 'hi' },
      tool_response: {},
      prompt: 'hello',
    })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it.each(HOOKS)('%s emits exactly one JSON object', (name) => {
    const out = execFileSync(
      'node',
      [resolve(__dirname, '..', '..', 'dist', 'hooks', `${name}.js`)],
      {
        input: payload,
        encoding: 'utf-8',
        // Stop would otherwise walk its real parent chain to the actual
        // /tmp/cc-socks this suite runs under, find a genuine ancestor (the
        // session running these tests), and spawn a real detached poller
        // this test never cleans up.
        env: { ...process.env, HOME: home, CLAUDITOR_SOCK_DIR: join(home, 'no-cc-socks') },
        timeout: 30_000,
      }
    )
    expect(() => JSON.parse(out || '{}')).not.toThrow()
  }, 30_000)

  it('survives a Bash response object, through the CLI as configured', () => {
    // tool_response is an object for Bash, and this hook called string methods
    // on it. The throw was masked for as long as the module caught its own
    // errors; called by name from the CLI it reached Claude Code as a hook
    // failure on every Bash call, in every session.
    const out = execFileSync(
      'node',
      [resolve(__dirname, '..', '..', 'dist', 'cli.js'), 'hook', 'post-tool-use'],
      {
        input: JSON.stringify({
          session_id: 'bash-object-probe',
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          cwd: home,
          tool_input: { command: 'npm test' },
          tool_response: {
            stdout: Array.from({ length: 200 }, (_, i) => `line ${i} of padding`).join('\n'),
            stderr: 'Error: something FAILED',
            interrupted: false,
          },
        }),
        encoding: 'utf-8',
        env: { ...process.env, HOME: home },
        timeout: 30_000,
      }
    )

    const decision = JSON.parse(out || '{}')
    // Reading the object at all is the fix: compression never ran for Bash.
    expect(decision.additionalContext).toContain('output compressed from')
  }, 30_000)
})

