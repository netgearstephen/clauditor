import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanCacheIssues } from './doctor.js'

function transcript(turns: Array<{ create: number; read: number }>): string {
  return turns
    .map((t, i) => JSON.stringify({
      type: 'assistant', uuid: `a${i}`, sessionId: 's', timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
      message: {
        role: 'assistant', model: 'claude-sonnet-4-6', content: [],
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: t.create, cache_read_input_tokens: t.read },
      },
    }))
    .join('\n') + '\n'
}

describe('scanCacheIssues', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clauditor-doctor-'))
    const project = join(dir, '-work-repo')
    mkdirSync(project)
    const broken = Array.from({ length: 10 }, (_, i) => ({ create: 1000 * (i + 1), read: 0 }))
    const healthy = Array.from({ length: 10 }, () => ({ create: 100, read: 50_000 }))
    writeFileSync(join(project, 'broken.jsonl'), transcript(broken))
    writeFileSync(join(project, 'healthy.jsonl'), transcript(healthy))
    writeFileSync(join(project, 'empty.jsonl'), '')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('counts sessions with turns and reports the broken one', async () => {
    const { sessions, issues } = await scanCacheIssues({ projectsDir: dir })
    expect(sessions).toBe(2)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ label: '-work-repo', severity: 'broken', turns: 10, cacheRatio: 0 })
    expect(issues[0].trend.length).toBeGreaterThan(0)
  })

  it('reports a degraded session as well as a broken one', async () => {
    const half = Array.from({ length: 10 }, () => ({ create: 50_000, read: 50_000 }))
    writeFileSync(join(dir, '-work-repo', 'degraded.jsonl'), transcript(half))
    const { sessions, issues } = await scanCacheIssues({ projectsDir: dir })
    expect(sessions).toBe(3)
    expect(issues.map((i) => i.severity).sort()).toEqual(['broken', 'degraded'])
  })
})
