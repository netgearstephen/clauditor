import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Whole-file reads are what ran the transcript scan out of heap, so this
// suite fails if any of the scan path falls back to one.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: vi.fn(async () => {
    throw new Error('whole-file read')
  }),
}))

const { parseJsonlFile, readJsonlRecords } = await import('./parser.js')
const { SessionWatcher } = await import('./watcher.js')
const { SessionStore } = await import('./store.js')

function assistant(i: number): string {
  return JSON.stringify({
    type: 'assistant', uuid: `a${i}`, sessionId: 's', timestamp: '2026-01-01T00:00:00Z',
    message: {
      role: 'assistant', model: 'claude-sonnet-4-6', content: [],
      usage: { input_tokens: i, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  })
}

describe('streamed transcript reads', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clauditor-stream-'))
    mkdirSync(join(dir, '-proj'))
    file = join(dir, '-proj', 's1.jsonl')
    writeFileSync(file, [assistant(1), 'not json', '', assistant(2)].join('\r\n') + '\r\n')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('parses a file line by line, skipping bad lines and CRLF endings', async () => {
    const records = await parseJsonlFile(file)
    expect(records.map((r) => r.uuid)).toEqual(['a1', 'a2'])
  })

  it('keeps a record whole when a string holds a line or paragraph separator', async () => {
    const text = 'one\u2028two\u2029three'
    writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: text } }) + '\n')
    const records = await parseJsonlFile(file)
    expect(records).toHaveLength(1)
    expect((records[0] as { message: { content: string } }).message.content).toBe(text)
  })

  it('joins a record that spans several stream chunks', async () => {
    // Over the 1 MiB read chunk, in two-byte characters, so a chunk ends mid-record and mid-character.
    const big = '\u00e9'.repeat(800_000)
    const lines = [assistant(1), JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: big } }), assistant(2)]
    writeFileSync(file, lines.join('\n'))
    const records = await parseJsonlFile(file)
    expect(records.map((r) => r.uuid)).toEqual(['a1', 'u1', 'a2'])
    expect((records[1] as { message: { content: string } }).message.content).toBe(big)
  })

  it('reads only the requested byte range', async () => {
    const start = Buffer.byteLength(assistant(1) + '\r\nnot json\r\n\r\n')
    const uuids: string[] = []
    for await (const record of readJsonlRecords(file, { start })) uuids.push(record.uuid as string)
    expect(uuids).toEqual(['a2'])
  })

  it('scans a projects directory without reading any file whole', async () => {
    const store = new SessionStore()
    await new SessionWatcher(store, { projectsDir: dir }).scanAll()
    expect(store.getAll().map((s) => s.turns.length)).toEqual([2])
  })
})
