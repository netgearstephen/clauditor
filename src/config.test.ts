import { describe, it, expect, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readConfig, writeConfigIfMissing, setProjectHubConfig } from './config.js'

// The sandbox home that vitest.setup.ts installed before any test module was
// imported, which is also the home config.ts resolved its path against.
const CONFIG_DIR = resolve(homedir(), '.clauditor')
const CONFIG_FILE = resolve(CONFIG_DIR, 'config.json')

/** Put a raw config on disk. readConfig re-reads the file every call. */
function write(raw: unknown) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(raw))
}

describe('readConfig', () => {
  afterEach(() => {
    // Left behind, this file would leak into every later suite that reads
    // config, which is most of them.
    rmSync(CONFIG_FILE, { force: true })
  })

  it('defaults the trigger and the pricing discount when the file is absent', () => {
    const c = readConfig()
    expect(c.rotation.trigger.peakContext).toBe(150_000)
    expect(c.pricing.discount).toBe(0)
  })

  it('defaults the trigger and the pricing discount when the file has neither', () => {
    write({ rotation: { enabled: true } })
    const c = readConfig()
    expect(c.rotation.trigger.peakContext).toBe(150_000)
    expect(c.rotation.trigger.buffer).toBe(0)
    expect(c.rotation.trigger.minRequestsSinceBank).toBe(20)
    expect(c.rotation.trigger.perModel).toEqual({})
    expect(c.pricing.discount).toBe(0)
    expect(c.pricing.perModel).toEqual({})
  })

  it('keeps the sibling defaults when only one nested key is set', () => {
    // The whole point of deepening the merge: a single perModel override used
    // to arrive as the entire trigger object and wipe out the rest.
    write({ rotation: { trigger: { perModel: { 'claude-opus-5': { peakContext: 120_000 } } } } })
    const t = readConfig().rotation.trigger
    expect(t.peakContext).toBe(150_000)
    expect(t.minRequestsSinceBank).toBe(20)
    expect(t.perModel['claude-opus-5'].peakContext).toBe(120_000)
  })

  it('honours minPeakContext as a deprecated alias for trigger.peakContext', () => {
    write({ rotation: { minPeakContext: 220_000 } })
    const c = readConfig()
    expect(c.rotation.trigger.peakContext).toBe(220_000)
    expect(c.rotation.minPeakContext).toBe(220_000)
  })

  it('lets an explicit trigger.peakContext win over the deprecated alias', () => {
    write({ rotation: { minPeakContext: 220_000, trigger: { peakContext: 130_000 } } })
    const c = readConfig()
    expect(c.rotation.trigger.peakContext).toBe(130_000)
    expect(c.rotation.minPeakContext).toBe(130_000)
  })

  it('never hands a caller the shared defaults object', () => {
    const first = readConfig()
    first.rotation.trigger.perModel['claude-opus-5'] = { peakContext: 1 }
    expect(readConfig().rotation.trigger.perModel).toEqual({})
  })

  it('compresses bash output by default and lets the config turn it off', () => {
    expect(readConfig().compression.bash).toBe(true)
    write({ compression: { bash: false } })
    expect(readConfig().compression.bash).toBe(false)
  })
})

describe('writeConfigIfMissing', () => {
  afterEach(() => rmSync(CONFIG_FILE, { force: true }))

  it('seeds a config that readConfig resolves to the tuned rotation', () => {
    expect(writeConfigIfMissing()).toBe(true)
    const c = readConfig()
    expect(c.rotation.trigger.peakContext).toBe(130_000)
    expect(c.rotation.trigger.perModel['claude-haiku-5'].peakContext).toBe(70_000)
    expect(c.rotation.reBankGrowth).toBe(50_000)
    expect(c.rotation.nudgeLead).toBe(25_000)
    expect(c.rotation.blockAfterBank).toBe(true)
    // Unseeded keys keep following the defaults instead of being frozen in.
    expect(c.rotation.trigger.minRequestsSinceBank).toBe(20)
    expect(JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')).pricing).toBeUndefined()
  })

  it('never overwrites an existing file', () => {
    write({ rotation: { trigger: { peakContext: 200_000 } } })
    const before = readFileSync(CONFIG_FILE, 'utf-8')
    expect(writeConfigIfMissing()).toBe(false)
    expect(readFileSync(CONFIG_FILE, 'utf-8')).toBe(before)
  })

  it('creates the directory when it is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clauditor-seed-'))
    try {
      const file = join(dir, 'nested', 'config.json')
      expect(writeConfigIfMissing(file)).toBe(true)
      expect(JSON.parse(readFileSync(file, 'utf-8')).rotation.nudgeLead).toBe(25_000)
      expect(readdirSync(join(dir, 'nested'))).toEqual(['config.json'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('seeds and stays lean when a hub login comes before install', () => {
    const hub = { apiKey: 'k', url: 'https://hub.example', developerHash: 'd' }
    setProjectHubConfig('github.com/a/b', hub)
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
    expect(Object.keys(raw).sort()).toEqual(['projects', 'rotation'])
    expect(raw.rotation.trigger).toEqual({ peakContext: 130_000, perModel: { 'claude-haiku-5': { peakContext: 70_000 } } })
    expect(raw.projects['github.com/a/b']).toEqual(hub)
    expect(readdirSync(CONFIG_DIR)).toEqual(['config.json'])
  })

  const hub = { apiKey: 'k', url: 'u', developerHash: 'd' }

  it('saves a hub project over a file holding non-object JSON', () => {
    write(null)
    setProjectHubConfig('github.com/a/b', hub)
    expect(Object.keys(JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')))).toEqual(['projects'])
  })

  it('replaces a non-object projects value rather than spreading it', () => {
    write({ projects: 'x' })
    setProjectHubConfig('github.com/a/b', hub)
    expect(JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')).projects).toEqual({ 'github.com/a/b': hub })
  })

  it('refuses to overwrite a config that does not parse', () => {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, '{ "rotation": { "nudgeLead": 1, } }')
    expect(() => setProjectHubConfig('github.com/a/b', hub)).toThrow(/not valid JSON/)
    expect(readFileSync(CONFIG_FILE, 'utf-8')).toBe('{ "rotation": { "nudgeLead": 1, } }')
  })
})
