import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// postinstall runs on import and resolves its paths against HOME at that moment.
describe('postinstall', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clauditor-postinstall-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.resetModules()
    // Its early exits sit inside its own try, so a throwing exit just ends the script.
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  })

  const installedHooks = () => {
    mkdirSync(join(home, '.claude'))
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'clauditor hook stop' }] }] } }),
    )
  }

  const configFile = () => join(home, '.clauditor', 'config.json')

  it('seeds the config for a user who has installed the hooks', async () => {
    installedHooks()
    await import('./postinstall.js')
    const cfg = JSON.parse(readFileSync(configFile(), 'utf-8'))
    expect(cfg.rotation.trigger.peakContext).toBe(130_000)
    expect(cfg.rotation.trigger.perModel['claude-haiku-5'].peakContext).toBe(70_000)
    expect(cfg.rotation.reBankGrowth).toBe(50_000)
    expect(cfg.rotation.nudgeLead).toBe(25_000)
    expect(cfg.rotation.blockAfterBank).toBe(true)
  })

  it('leaves an existing config byte for byte as it was', async () => {
    mkdirSync(join(home, '.clauditor'))
    const mine = '{"rotation":{"trigger":{"peakContext":200000}}}'
    writeFileSync(configFile(), mine)
    installedHooks()
    await import('./postinstall.js')
    expect(readFileSync(configFile(), 'utf-8')).toBe(mine)
  })

  it('still registers missing hooks after seeding the config', async () => {
    installedHooks()
    await import('./postinstall.js')
    const hooks = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')).hooks
    expect(hooks.PreToolUse[0].hooks[0].command).toBe('clauditor hook pre-tool-use')
    expect(existsSync(configFile())).toBe(true)
  })

  it('still registers missing hooks when the config cannot be seeded', async () => {
    installedHooks()
    writeFileSync(join(home, '.clauditor'), 'not a directory')
    await import('./postinstall.js')
    const hooks = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')).hooks
    expect(hooks.PreToolUse[0].hooks[0].command).toBe('clauditor hook pre-tool-use')
  })

  it('writes nothing for an audit-only user with no clauditor hooks', async () => {
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude', 'settings.json'), '{}')
    await import('./postinstall.js')
    expect(process.exit).toHaveBeenCalledWith(0)
    expect(existsSync(configFile())).toBe(false)
  })
})
