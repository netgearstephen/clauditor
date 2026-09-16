import { describe, it, expect, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { readConfig } from './config.js'

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
})
