import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installHooks } from './install.js'

/**
 * Hook installation, against a throwaway claudeDir.
 *
 * Never the real ~/.claude: installHooks takes the directory as a parameter
 * precisely so this can be exercised without rewriting the developer's own
 * settings.
 */
describe('installHooks', () => {
  let claudeDir: string

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), 'clauditor-install-'))
  })

  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true })
  })

  const hooks = () =>
    JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8')).hooks as Record<
      string,
      { matcher: string; hooks: { type: string; command: string }[] }[]
    >

  const commands = (event: string) =>
    (hooks()[event] ?? []).flatMap((c) => c.hooks.map((h) => h.command))

  it('installs the PreToolUse hook, without which a banked session has no guard', async () => {
    // The wind-down guard runs in PreToolUse. A fresh install without it
    // ships a watchdog that banks unasked and then leaves the session free to
    // make the handoff it just wrote stale, which is the whole of what Task
    // 4 was for.
    await installHooks(claudeDir)
    expect(commands('PreToolUse')).toContain('clauditor hook pre-tool-use')
  })

  it('installs every hook the CLI can dispatch', async () => {
    await installHooks(claudeDir)
    const installed = Object.keys(hooks()).sort()
    expect(installed).toEqual(
      [
        'Notification',
        'PostCompact',
        'PostToolUse',
        'PreCompact',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'UserPromptSubmit',
      ].sort()
    )
  })

  it('skips an event that is already hand-wired, rather than doubling it', async () => {
    // A machine whose settings already name the hook must not end up running
    // it twice per tool call.
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: '', hooks: [{ type: 'command', command: 'clauditor hook pre-tool-use' }] },
          ],
        },
      })
    )

    const messages = await installHooks(claudeDir)

    expect(commands('PreToolUse')).toEqual(['clauditor hook pre-tool-use'])
    expect(messages).toContain('PreToolUse: already installed (skipped)')
  })

  it('adds itself alongside somebody else\'s hook on the same event', async () => {
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'other-tool check' }] }],
        },
      })
    )

    await installHooks(claudeDir)

    expect(commands('PreToolUse')).toEqual(['other-tool check', 'clauditor hook pre-tool-use'])
  })

  it('names the peak gate in the handoff message', async () => {
    // Install has no model, so the resolved gate is the top-level default,
    // not a per-model override or a window clamp. 150k pins that default.
    const messages = await installHooks(claudeDir)
    expect(messages.join('\n')).toContain('peak context reaches 150k')
  })
})
