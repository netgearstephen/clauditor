import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    linkSync: () => { throw Object.assign(new Error('link not supported'), { code: 'EPERM' }) },
  }
})

const { writeConfigIfMissing } = await import('./config.js')

describe('writeConfigIfMissing without hard links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clauditor-nolink-'))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes the seed directly and leaves no temp file', () => {
    const file = join(dir, 'config.json')
    expect(writeConfigIfMissing(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf-8')).rotation.nudgeLead).toBe(25_000)
    expect(readdirSync(dir)).toEqual(['config.json'])
    expect(writeConfigIfMissing(file)).toBe(false)
  })
})
