import { watch, type FSWatcher } from 'chokidar'
import { resolve, basename, sep } from 'node:path'
import { homedir } from 'node:os'
import { readdir, stat } from 'node:fs/promises'
import { readJsonlRecords, TranscriptAccumulator } from './parser.js'
import { SessionStore } from './store.js'

export interface WatcherOptions {
  projectsDir?: string
  projectPath?: string
  pollInterval?: number
}

export class SessionWatcher {
  private watcher: FSWatcher | null = null
  private store: SessionStore
  private projectsDir: string
  private projectPath: string | null
  private pollInterval: number

  // Only filled once start() is watching: a one-shot scan of every transcript
  // must not keep per-file state, or its memory grows with the whole history.
  private fileOffsets = new Map<string, number>()
  private fileState = new Map<string, TranscriptAccumulator>()
  private following = false
  // The accumulators are mutated in place, so two reads of one file must not overlap.
  private queues = new Map<string, Promise<void>>()

  constructor(store: SessionStore, options: WatcherOptions = {}) {
    this.store = store
    this.projectsDir = resolveHome(options.projectsDir || '~/.claude/projects')
    this.projectPath = options.projectPath || null
    this.pollInterval = options.pollInterval || 1000
  }

  async start(): Promise<void> {
    this.following = true
    // Eagerly scan existing files first so the TUI has data immediately
    await this.scanAll()

    const watchDir = this.projectPath
      ? resolve(this.projectsDir, encodeProjectPath(this.projectPath))
      : this.projectsDir

    // Watch the directory directly — chokidar v4 has issues with
    // glob patterns like **/*.jsonl on some systems. Filter in handlers.
    this.watcher = watch(watchDir, {
      persistent: true,
      ignoreInitial: true,
      usePolling: true,
      interval: this.pollInterval,
      depth: 4,
    })

    this.watcher.on('add', (filePath) => {
      if (filePath.endsWith('.jsonl')) this.enqueue(filePath, () => this.processFile(filePath))
    })
    this.watcher.on('change', (filePath) => {
      if (filePath.endsWith('.jsonl')) this.enqueue(filePath, () => this.processFileIncremental(filePath))
    })
  }

  private enqueue(filePath: string, task: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(filePath) ?? Promise.resolve()).then(task, task)
    this.queues.set(filePath, next)
    const done = () => {
      if (this.queues.get(filePath) === next) this.queues.delete(filePath)
    }
    next.then(done, done)
    return next
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }
    this.following = false
    await Promise.allSettled(this.queues.values())
    this.fileState.clear()
    this.fileOffsets.clear()
  }

  getStore(): SessionStore {
    return this.store
  }

  async scanAll(): Promise<void> {
    const dir = this.projectPath
      ? resolve(this.projectsDir, encodeProjectPath(this.projectPath))
      : this.projectsDir

    try {
      await this.scanDirectory(dir)
    } catch {
      // Directory may not exist yet
    }
  }

  /**
   * Parse only the newest transcripts, bounded by count and total bytes.
   * scanAll parses every transcript ever written and the default store keeps
   * every session, which is fine for an on-demand command but froze the
   * machine when every pane of a herdr restore ran it from the SessionStart
   * hook at once.
   */
  async scanRecent({ maxFiles, maxBytes = Infinity }: { maxFiles: number; maxBytes?: number }): Promise<void> {
    const dir = this.projectPath
      ? resolve(this.projectsDir, encodeProjectPath(this.projectPath))
      : this.projectsDir

    const files: { path: string; mtime: number; size: number }[] = []
    await this.collectTranscripts(dir, files)
    files.sort((a, b) => b.mtime - a.mtime)

    let taken = 0
    let bytes = 0
    for (const file of files) {
      if (taken >= maxFiles) break
      if (bytes + file.size > maxBytes) continue
      taken++
      bytes += file.size
      await this.processFile(file.path)
    }
  }

  private async collectTranscripts(
    dir: string,
    out: { path: string; mtime: number; size: number }[],
  ): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = resolve(dir, entry.name)
        if (entry.isDirectory()) {
          await this.collectTranscripts(fullPath, out)
        } else if (entry.name.endsWith('.jsonl')) {
          try {
            const s = await stat(fullPath)
            out.push({ path: fullPath, mtime: s.mtimeMs, size: s.size })
          } catch {}
        }
      }
    } catch {
      // Ignore errors from missing directories
    }
  }

  private async scanDirectory(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = resolve(dir, entry.name)
        if (entry.isDirectory()) {
          await this.scanDirectory(fullPath)
        } else if (entry.name.endsWith('.jsonl')) {
          await this.processFile(fullPath)
        }
      }
    } catch {
      // Ignore errors from missing directories
    }
  }

  /**
   * Full parse, streamed: used for the initial scan and for new files.
   */
  private async processFile(filePath: string): Promise<void> {
    try {
      const { size } = await stat(filePath)
      const accumulator = new TranscriptAccumulator()
      if (size > 0) {
        for await (const record of readJsonlRecords(filePath, { end: size - 1 })) accumulator.add(record)
      }

      if (this.following) {
        this.fileState.set(filePath, accumulator)
        this.fileOffsets.set(filePath, size)
      }

      this.updateStore(filePath, accumulator)
    } catch {
      // Ignore corrupt or in-progress files
    }
  }

  /**
   * Incremental parse — only read new bytes appended since last read.
   * Falls back to full parse if incremental read fails.
   */
  private async processFileIncremental(filePath: string): Promise<void> {
    const lastOffset = this.fileOffsets.get(filePath)
    const accumulator = this.fileState.get(filePath)

    if (lastOffset === undefined || !accumulator) {
      return this.processFile(filePath)
    }

    try {
      const fileStat = await stat(filePath)

      if (fileStat.size <= lastOffset) {
        // Truncated, or rewritten in place: polling only reports a change when mtime moves.
        return this.processFile(filePath)
      }

      for await (const record of readJsonlRecords(filePath, { start: lastOffset, end: fileStat.size - 1 })) {
        accumulator.add(record)
      }
      this.fileOffsets.set(filePath, fileStat.size)

      this.updateStore(filePath, accumulator)
    } catch {
      // The accumulator may hold part of the failed read, so start again from nothing.
      this.fileState.delete(filePath)
      this.fileOffsets.delete(filePath)
      return this.processFile(filePath)
    }
  }

  private updateStore(filePath: string, transcript: TranscriptAccumulator): void {
    const sessionId = extractSessionId(filePath)
    const projectPath = extractProjectPath(filePath, this.projectsDir)
    const turns = transcript.getTurns()

    if (turns.length > 0) {
      this.store.update(
        sessionId,
        filePath,
        projectPath,
        turns,
        transcript.getModel(),
        transcript.getContext(),
        transcript.isResumed(),
      )
    }
  }
}

export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-')
}

function extractSessionId(filePath: string): string {
  const filename = basename(filePath)
  return filename.replace('.jsonl', '')
}

function extractProjectPath(filePath: string, projectsDir: string): string {
  const relative = filePath
    .replace(projectsDir + sep, '')
    .replace(projectsDir + '/', '')
  const parts = relative.split(sep)
  return parts[0] || 'unknown'
}

function resolveHome(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return resolve(homedir(), filepath.slice(2))
  }
  return filepath
}
