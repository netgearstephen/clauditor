import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionWatcher } from './watcher.js'
import { SessionStore } from './store.js'

function transcript(sessionId: string, turns = 1): string {
  const lines: string[] = []
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({
      type: 'user', uuid: `u${i}`, parentUuid: null, sessionId,
      timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' },
    }))
    lines.push(JSON.stringify({
      type: 'assistant', uuid: `a${i}`, parentUuid: `u${i}`, sessionId,
      timestamp: '2026-01-01T00:00:01Z',
      message: {
        role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }))
  }
  return lines.join('\n') + '\n'
}

describe('SessionWatcher.scanRecent', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clauditor-watcher-'))
    const now = Date.now() / 1000
    for (let i = 0; i < 6; i++) {
      const project = join(dir, `-proj-${i % 2}`)
      mkdirSync(project, { recursive: true })
      const file = join(project, `s${i}.jsonl`)
      writeFileSync(file, transcript(`s${i}`))
      // s5 is the newest, s0 the oldest
      utimesSync(file, now - (6 - i) * 60, now - (6 - i) * 60)
    }
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('parses only the newest files up to maxFiles', async () => {
    const store = new SessionStore()
    await new SessionWatcher(store, { projectsDir: dir }).scanRecent({ maxFiles: 2 })
    expect(store.getAll().map((s) => s.sessionId).sort()).toEqual(['s4', 's5'])
  })

  it('stops before the byte budget is exceeded', async () => {
    const store = new SessionStore()
    const oneFile = Buffer.byteLength(transcript('s0'))
    await new SessionWatcher(store, { projectsDir: dir }).scanRecent({ maxFiles: 10, maxBytes: oneFile * 3 })
    expect(store.getAll().map((s) => s.sessionId).sort()).toEqual(['s3', 's4', 's5'])
  })

  it('skips a file larger than the remaining budget and keeps going', async () => {
    const big = join(dir, '-proj-1', 's5.jsonl')
    writeFileSync(big, transcript('s5', 50))
    const now = Date.now() / 1000
    utimesSync(big, now, now)
    const store = new SessionStore()
    const oneFile = Buffer.byteLength(transcript('s0'))
    await new SessionWatcher(store, { projectsDir: dir }).scanRecent({ maxFiles: 10, maxBytes: oneFile * 2 })
    expect(store.getAll().map((s) => s.sessionId).sort()).toEqual(['s3', 's4'])
  })
})
