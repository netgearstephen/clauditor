import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
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
    // installHooks seeds the sandbox config; left behind, it would change later tests' gate.
    rmSync(join(homedir(), '.clauditor', 'config.json'), { force: true })
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

  it('names per-model gates net of the buffer, as the top-level gate is', async () => {
    mkdirSync(join(homedir(), '.clauditor'), { recursive: true })
    writeFileSync(join(homedir(), '.clauditor', 'config.json'), JSON.stringify({
      rotation: { trigger: { peakContext: 130_000, buffer: 10_000, perModel: { 'claude-haiku-5': { peakContext: 70_000 } } } },
    }))
    const messages = await installHooks(claudeDir)
    expect(messages.join('\n')).toContain('peak context reaches 120k (claude-haiku-5 60k).')
  })

  it('skips a malformed per-model entry in the handoff message', async () => {
    mkdirSync(join(homedir(), '.clauditor'), { recursive: true })
    writeFileSync(join(homedir(), '.clauditor', 'config.json'),
      JSON.stringify({ rotation: { trigger: { perModel: { 'claude-opus-5': null } } } }))
    const messages = await installHooks(claudeDir)
    expect(messages.join('\n')).toContain('peak context reaches 150k. ')
  })

  it('names the top-level and per-model gates in the handoff message', async () => {
    const messages = await installHooks(claudeDir)
    expect(messages.join('\n')).toContain('peak context reaches 130k (claude-haiku-5 70k).')
    expect(messages.join('\n')).toContain('edits that would make it stale are refused')
  })
})
