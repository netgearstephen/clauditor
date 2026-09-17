import { describe, it, expect } from 'vitest'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  shouldIdleBank,
  isProcessAlive,
  readInboxAuth,
  IDLE_BANK_DELAY_MS,
  SEND_TIMEOUT_MS,
  type IdleBankFacts,
  type InboxAuth,
} from './idle-watchdog.js'

/** A session that is idle, large, warm, unbanked and still listening. */
const eligible: IdleBankFacts = {
  msSinceLastTurn: IDLE_BANK_DELAY_MS + 1_000,
  peakContext: 120_000,
  alreadyBanked: false,
  growthSinceBank: 0,
  rotationEnabled: true,
  reBankGrowth: 100_000,
  requestsSinceBank: 1_000,
  minRequestsSinceBank: 0,
  socketExists: true,
}

describe('shouldIdleBank', () => {
  it('banks a large, idle, warm session that is still listening', () => {
    expect(shouldIdleBank(eligible)).toEqual({ act: 'bank' })
  })

  it('does nothing when a newer turn has landed since the timer was armed', () => {
    // The timer wakes on a clock; the transcript is the authority on whether
    // the session is actually idle.
    const verdict = shouldIdleBank({ ...eligible, msSinceLastTurn: 60_000 })
    expect(verdict.act).toBe('nothing')
  })

  it('marks a turn landed since arming as retryable, so the timer can wait again', () => {
    // The clock said fire, the transcript said not yet. That is the one
    // stand-down that says nothing final about the session: it is still
    // alive, still large, still unbanked, and will go quiet later. The timer
    // pushes its fire time out on this flag rather than deleting itself.
    expect(shouldIdleBank({ ...eligible, msSinceLastTurn: 60_000 })).toEqual({
      act: 'nothing',
      reason: 'a turn landed since arming',
      retry: true,
    })
  })

  it('leaves every genuinely final stand-down unmarked', () => {
    // Deleting the timer is right for these: a session that has banked,
    // has rotation off, or is too small to be worth banking will not become
    // eligible by being waited on.
    expect(shouldIdleBank({ ...eligible, msSinceLastTurn: null }).retry).toBeUndefined()
    expect(shouldIdleBank({ ...eligible, rotationEnabled: false }).retry).toBeUndefined()
    expect(shouldIdleBank({ ...eligible, peakContext: 64_999 }).retry).toBeUndefined()
    expect(
      shouldIdleBank({ ...eligible, alreadyBanked: true, growthSinceBank: 40_000 }).retry
    ).toBeUndefined()
  })

  it('does nothing when the transcript cannot be read', () => {
    expect(shouldIdleBank({ ...eligible, msSinceLastTurn: null }).act).toBe('nothing')
  })

  it('does nothing below the resume break-even', () => {
    // Below it the handoff's own entry cost eats the whole saving.
    expect(shouldIdleBank({ ...eligible, peakContext: 64_999 }).act).toBe('nothing')
  })

  it('banks exactly at the resume break-even', () => {
    expect(shouldIdleBank({ ...eligible, peakContext: 65_000 })).toEqual({ act: 'bank' })
  })

  it('does nothing when rotation is switched off', () => {
    expect(shouldIdleBank({ ...eligible, rotationEnabled: false }).act).toBe('nothing')
  })

  it('does nothing when the session has already banked and has not grown', () => {
    expect(
      shouldIdleBank({ ...eligible, alreadyBanked: true, growthSinceBank: 40_000 }).act
    ).toBe('nothing')
  })

  it('banks again once the session has grown past the re-bank step', () => {
    expect(
      shouldIdleBank({ ...eligible, alreadyBanked: true, growthSinceBank: 100_000 })
    ).toEqual({ act: 'bank' })
  })

  it('notifies rather than banks once the cache has gone cold', () => {
    // Banking after expiry costs full price, and the saving it existed for
    // has already been lost.
    expect(
      shouldIdleBank({ ...eligible, msSinceLastTurn: 61 * 60 * 1000 })
    ).toEqual({ act: 'notify', reason: 'cache-cold' })
  })

  it('notifies when the session has exited and its socket has gone', () => {
    expect(shouldIdleBank({ ...eligible, socketExists: false })).toEqual({
      act: 'notify',
      reason: 'session-gone',
    })
  })

  it('says nothing about a small session whose socket has gone', () => {
    // Nothing to say: it was never worth banking.
    expect(
      shouldIdleBank({ ...eligible, socketExists: false, peakContext: 10_000 }).act
    ).toBe('nothing')
  })

  it('stands down when too few requests have passed since the last bank', () => {
    const v = shouldIdleBank({
      ...eligible,
      alreadyBanked: true,
      growthSinceBank: 80_000,
      requestsSinceBank: 4,
      minRequestsSinceBank: 20,
    })
    expect(v).toEqual({ act: 'nothing', reason: 'too few requests since the last bank' })
  })

  it('does not mark the request floor retryable', () => {
    // Waiting cannot add requests to a session that is idle by definition,
    // and if a turn does land the earlier idleness check catches it first. A
    // retry here would be a poller kept alive for a verdict that cannot move.
    const v = shouldIdleBank({ ...eligible, requestsSinceBank: 1, minRequestsSinceBank: 20 })
    expect(v.retry).toBeUndefined()
  })

  it('banks once the floor is met', () => {
    expect(
      shouldIdleBank({ ...eligible, requestsSinceBank: 40, minRequestsSinceBank: 20 })
    ).toEqual({ act: 'bank' })
  })
})

import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, vi } from 'vitest'

async function importFresh(tempDir: string) {
  vi.resetModules()
  vi.doMock('node:os', () => ({ homedir: () => tempDir }))
  return await import('./idle-watchdog.js')
}

describe('the timer file', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-timer-'))
  })
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    vi.doUnmock('node:os')
  })

  const file = (over: Record<string, unknown> = {}) => ({
    sessionId: 'sess-1',
    timerPid: process.pid,
    claudePid: process.pid,
    socketPath: '/tmp/cc-socks/1.sock',
    token: 'secret-token',
    cwd: '/home/user/project-a',
    transcriptPath: '/home/user/.claude/projects/p/sess-1.jsonl',
    armedAt: 1_000,
    firesAt: 2_000,
    ...over,
  })

  it('round-trips what the timer needs to act', async () => {
    const w = await importFresh(tempDir)
    w.writeTimerFile(file() as never)
    expect(w.readTimerFile('sess-1')).toEqual(file())
  })

  it('is readable only by its owner, because it carries a live token', async () => {
    const w = await importFresh(tempDir)
    w.writeTimerFile(file() as never)
    const mode = statSync(w.timerFilePath('sess-1')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('returns null for a session with no timer, and for a corrupt file', async () => {
    const w = await importFresh(tempDir)
    expect(w.readTimerFile('nobody')).toBeNull()
    mkdirSync(w.TIMERS_DIR, { recursive: true })
    writeFileSync(w.timerFilePath('broken'), '{ not json')
    expect(w.readTimerFile('broken')).toBeNull()
  })

  it('refuses a session id that is not a plain file name', async () => {
    const w = await importFresh(tempDir)
    expect(w.timerFilePath('../../escape')).toBeNull()
    expect(w.readTimerFile('../../escape')).toBeNull()
  })

  it('sweeps a timer whose process is dead', async () => {
    const w = await importFresh(tempDir)
    // PID 2^22 is above every pid_max in use and owns nothing.
    w.writeTimerFile(file({ sessionId: 'dead', timerPid: 4_194_304 }) as never)
    w.sweepTimerFiles()
    expect(existsSync(w.timerFilePath('dead')!)).toBe(false)
  })

  it('sweeps a timer whose session has exited, socket and all', async () => {
    const w = await importFresh(tempDir)
    w.writeTimerFile(file({ sessionId: 'gone', socketPath: join(tempDir, 'no.sock') }) as never)
    w.sweepTimerFiles()
    expect(existsSync(w.timerFilePath('gone')!)).toBe(false)
  })

  it('leaves a live timer alone', async () => {
    const w = await importFresh(tempDir)
    const sock = join(tempDir, 'live.sock')
    writeFileSync(sock, '')
    w.writeTimerFile(file({ sessionId: 'live', socketPath: sock }) as never)
    w.sweepTimerFiles()
    expect(existsSync(w.timerFilePath('live')!)).toBe(true)
  })

  it('sweeps a dead file by name, not by its recorded sessionId', async () => {
    // A timer file whose sessionId field names a different, live session.
    // The sweep must delete the dead file by name, not route through deleteTimerFile,
    // which would delete the wrong file.
    const w = await importFresh(tempDir)
    const liveSocket = join(tempDir, 'live.sock')
    writeFileSync(liveSocket, '')

    // Write a live timer for 'session-a' with a live process
    w.writeTimerFile(file({ sessionId: 'session-a', timerPid: process.pid, socketPath: liveSocket }) as never)

    // Manually create a dead timer file with filename 'dead-file.json' but sessionId content pointing to 'session-a'
    const deadPath = w.timerFilePath('dead-file')!
    const corruptedContent = JSON.stringify({
      sessionId: 'session-a',  // points to the live session
      timerPid: 4_194_304,  // dead pid
      claudePid: process.pid,
      socketPath: liveSocket,
      token: 'secret-token',
      cwd: '/home/user/project-a',
      transcriptPath: '/home/user/.claude/projects/p/sess-1.jsonl',
      armedAt: 1_000,
      firesAt: 2_000,
    }, null, 2)
    writeFileSync(deadPath, corruptedContent, { mode: 0o600 })

    w.sweepTimerFiles()

    // The dead file should be deleted by its actual filename
    expect(existsSync(w.timerFilePath('dead-file')!)).toBe(false)
    // The live session's file should still exist, untouched
    expect(existsSync(w.timerFilePath('session-a')!)).toBe(true)
  })
})

describe('resolveClaudePid', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-sock-resolve-'))
  })
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    vi.doUnmock('node:os')
  })

  it('finds the ancestor whose socket exists', async () => {
    const w = await importFresh(tempDir)
    const sockDir = join(tempDir, 'cc-socks')
    mkdirSync(sockDir, { recursive: true })
    writeFileSync(join(sockDir, `${process.ppid}.sock`), '')
    const found = w.resolveClaudePid(process.pid, sockDir)
    expect(found?.pid).toBe(process.ppid)
    expect(found?.socketPath).toBe(join(sockDir, `${process.ppid}.sock`))
  })

  it('returns null when no ancestor is listening', async () => {
    const w = await importFresh(tempDir)
    expect(w.resolveClaudePid(process.pid, join(tempDir, 'empty'))).toBeNull()
  })
})

describe('sendToInbox', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-sock-'))
  })
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  const auth: InboxAuth = { peerToken: 'secret-token', name: 'clauditor-x1', mode: 'bypass' }

  /** Collects the lines a send writes, so each test can assert on the frames. */
  async function capture(
    w: Awaited<ReturnType<typeof importFresh>>,
    sockPath: string,
    message = 'bank please'
  ) {
    const lines: string[] = []
    const server = createServer((c) => {
      c.on('data', (b) => lines.push(...b.toString().split('\n').filter(Boolean)))
    })
    await new Promise<void>((r) => server.listen(sockPath, r))
    const ok = await w.sendToInbox(sockPath, auth, message)
    await new Promise((r) => setTimeout(r, 50))
    server.close()
    return { ok, lines }
  }

  it('authenticates before it says anything else', async () => {
    const w = await importFresh(tempDir)
    const sockPath = join(tempDir, 'inbox.sock')

    const { ok, lines } = await capture(w, sockPath)

    expect(ok).toBe(true)
    expect(JSON.parse(lines[0])).toEqual({ type: 'auth', token: 'secret-token' })
  })

  it('sends a frame the inbox dispatches, not one it discards', async () => {
    // The inbox routes on type 'user' and reads the body from message.content.
    // The old {type:'message', message:'<string>'} frame authenticated, was
    // accepted, matched no handler and was dropped in silence: the reason the
    // watchdog never banked once in fourteen firings.
    const w = await importFresh(tempDir)
    const sockPath = join(tempDir, 'inbox.sock')

    const { lines } = await capture(w, sockPath)

    const frame = JSON.parse(lines[1])
    expect(frame).toMatchObject({
      msgV: 1,
      type: 'user',
      message: { role: 'user' },
      priority: 'next',
      from: `uds:${sockPath}`,
    })
    expect(frame.msg_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
    expect(frame.message.content).toContain('bank please')
  })

  it('attests its permission mode, so the message is not held for an approval nobody will give', async () => {
    // Without the attestation a bypassing session holds the message with
    // reason 'no-mode-asserted' and waits for a human who, by the whole
    // premise of an idle-bank watchdog, has walked away.
    const w = await importFresh(tempDir)
    const sockPath = join(tempDir, 'inbox.sock')

    const { lines } = await capture(w, sockPath)

    expect(JSON.parse(lines[1]).message.content).toContain(
      `<cross-session-message from="uds:${sockPath}" from-name="clauditor-x1" from-mode="bypass">`
    )
  })

  it('reports failure rather than throwing when nothing is listening', async () => {
    const w = await importFresh(tempDir)
    await expect(w.sendToInbox(join(tempDir, 'absent.sock'), auth, 'hi')).resolves.toBe(false)
  })

  it(
    'gives up rather than waiting forever on a peer that never reads',
    async () => {
      const w = await importFresh(tempDir)
      const sockPath = join(tempDir, 'wedged.sock')
      // Accepts the connection and then never reads from it, so the
      // message's write callback never fires: exactly the wedged-peer
      // scenario the timeout exists for.
      const server = createServer(() => {})
      await new Promise<void>((r) => server.listen(sockPath, r))

      // A message large enough to overrun the kernel's socket buffers, so the
      // write genuinely cannot flush while nothing on the other end reads:
      // a tiny message would clear the buffer and flush regardless.
      const ok = await w.sendToInbox(sockPath, auth, 'x'.repeat(16 * 1024 * 1024))
      server.close()

      expect(ok).toBe(false)
      // Comfortably above the constant, not equal to it: a socket blocked on
      // a large synchronous write can take a multiple of the configured
      // timeout to actually settle, and this must not flake because of that.
    },
    SEND_TIMEOUT_MS * 3
  )
})

describe('readInboxAuth', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-auth-'))
  })
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  /** Publish the two files Claude Code writes for a live session. */
  function publish(sockPath: string, over: Record<string, unknown> = {}): string {
    const dir = join(tempDir, 'sessions')
    mkdirSync(dir, { recursive: true })
    const pid = Number(sockPath.match(/(\d+)\.sock$/)![1])
    const hash = createHash('sha256').update(sockPath).digest('hex')
    writeFileSync(join(dir, `${pid}.${hash}.key`), JSON.stringify({ peerToken: 'peer-secret' }))
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, name: 'clauditor-x1', ...over }))
    return dir
  }

  it('reads the peer token, which is not the token in the hook environment', () => {
    // CLAUDE_CODE_MESSAGING_TOKEN is the childToken, and it only counts for a
    // sender the session can still see as its own descendant. A detached
    // poller is not one, so it must present the peerToken from the key file.
    const sockPath = join(tempDir, '4242.sock')
    const dir = publish(sockPath)

    expect(readInboxAuth(sockPath, dir, () => 'claude')?.peerToken).toBe('peer-secret')
  })

  it('reads the session name the inbox renders the message under', () => {
    const sockPath = join(tempDir, '4242.sock')
    const dir = publish(sockPath)

    expect(readInboxAuth(sockPath, dir, () => 'claude')?.name).toBe('clauditor-x1')
  })

  it('calls a session that skips permission prompts a bypassing one', () => {
    const sockPath = join(tempDir, '4242.sock')
    const dir = publish(sockPath)

    const command = 'claude --dangerously-skip-permissions'
    expect(readInboxAuth(sockPath, dir, () => command)?.mode).toBe('bypass')
  })

  it('calls any other session a prompting one, so parity is never overclaimed', () => {
    // Claiming 'bypass' at a prompting session earns a mode-mismatch hold,
    // which is the same dead end as asserting no mode at all.
    const sockPath = join(tempDir, '4242.sock')
    const dir = publish(sockPath)

    expect(readInboxAuth(sockPath, dir, () => 'claude')?.mode).toBe('prompting')
  })

  it('returns null when the session has gone and taken its key file with it', () => {
    const sockPath = join(tempDir, '4242.sock')
    mkdirSync(join(tempDir, 'sessions'), { recursive: true })

    expect(readInboxAuth(sockPath, join(tempDir, 'sessions'), () => 'claude')).toBeNull()
  })
})

describe('isProcessAlive', () => {
  it('says a live pid is alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('says a pid above every pid_max is not', () => {
    expect(isProcessAlive(4_194_304)).toBe(false)
  })

  it('refuses pid 0, which signals the whole process group', () => {
    // process.kill(0, 0) succeeds, so a naive liveness test calls 0 alive.
    // armIdleTimer writes 0 whenever a spawn produces no pid, and a 0 that
    // reads as alive is never respawned and never swept: the session is
    // unwatched for ever, with a file on disk carrying a live auth token.
    expect(isProcessAlive(0)).toBe(false)
  })

  it('refuses a negative pid, which signals a process group', () => {
    expect(isProcessAlive(-1)).toBe(false)
  })
})

describe('the poller entry point', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-poller-'))
  })
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    vi.doUnmock('node:os')
  })

  it('finds the poller beside the hooks, where the bundled CLI sits', async () => {
    const w = await importFresh(tempDir)
    mkdirSync(join(tempDir, 'hooks'), { recursive: true })
    writeFileSync(join(tempDir, 'hooks', 'idle-timer.js'), '')
    expect(w.resolvePollerEntry(tempDir)).toBe(join(tempDir, 'hooks', 'idle-timer.js'))
  })

  it('finds the poller alongside itself, where the unbundled hook sits', async () => {
    const w = await importFresh(tempDir)
    writeFileSync(join(tempDir, 'idle-timer.js'), '')
    expect(w.resolvePollerEntry(tempDir)).toBe(join(tempDir, 'idle-timer.js'))
  })

  it('returns null rather than guessing a layout that is not there', async () => {
    const w = await importFresh(tempDir)
    expect(w.resolvePollerEntry(tempDir)).toBeNull()
  })

  it('reports a spawn failure instead of throwing after the hook has returned', async () => {
    // An unhandled 'error' event on a ChildProcess throws, and it throws
    // asynchronously, after armIdleTimer has returned and outside
    // handleStopHook's promise chain, so runHookSafely cannot catch it: a
    // spawn failure would take the Stop hook down before it wrote a decision.
    const w = await importFresh(tempDir)
    const pid = w.spawnPoller(join(tempDir, 'absent.js'), 'sess-1', join(tempDir, 'no-such-node'))
    expect(pid).toBe(0)
    // Long enough for the error event to have been emitted and, unhandled,
    // to have brought this process down.
    await new Promise((r) => setTimeout(r, 200))
  })
})

describe('the recorded socket', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-sock-ino-'))
  })
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    vi.doUnmock('node:os')
  })

  it('is ours when the inode still matches', async () => {
    const w = await importFresh(tempDir)
    const sock = join(tempDir, 'a.sock')
    writeFileSync(sock, '')
    expect(w.socketStillOurs({ socketPath: sock, socketInode: w.socketInode(sock) })).toBe(true)
  })

  it('is not ours once another session has taken that pid and that path', async () => {
    // Sockets are keyed by pid, and the recorded path is up to 55 minutes old
    // at fire time. If the original claude exits and a new one takes the pid,
    // existsSync is satisfied by a socket belonging to a stranger.
    const w = await importFresh(tempDir)
    const sock = join(tempDir, 'b.sock')
    writeFileSync(sock, '')
    const mine = w.socketInode(sock)
    rmSync(sock)
    writeFileSync(sock, '')
    expect(w.socketStillOurs({ socketPath: sock, socketInode: mine })).toBe(false)
  })

  it('is not ours when the socket has gone entirely', async () => {
    const w = await importFresh(tempDir)
    expect(w.socketStillOurs({ socketPath: join(tempDir, 'gone.sock') })).toBe(false)
  })

  it('takes a missing inode as no check available, not as a mismatch', async () => {
    // Timer files already on disk when this shipped have no inode field.
    // Reading absence as a mismatch would strand every one of them.
    const w = await importFresh(tempDir)
    const sock = join(tempDir, 'c.sock')
    writeFileSync(sock, '')
    expect(w.socketStillOurs({ socketPath: sock })).toBe(true)
  })

  it('records the inode at arm time, so the fire-time check has something to compare', async () => {
    const w = await importFresh(tempDir)
    const sockDir = join(tempDir, 'cc-socks')
    mkdirSync(sockDir, { recursive: true })
    const sock = join(sockDir, `${process.ppid}.sock`)
    writeFileSync(sock, '')
    expect(w.socketInode(sock)).toBe(statSync(sock).ino)
  })

  it('reads no inode from a path with nothing at it', async () => {
    const w = await importFresh(tempDir)
    expect(w.socketInode(join(tempDir, 'nothing.sock'))).toBeUndefined()
  })

  it('sweeps a timer whose socket path now belongs to another session', async () => {
    const w = await importFresh(tempDir)
    const sock = join(tempDir, 'reused.sock')
    writeFileSync(sock, '')
    const mine = w.socketInode(sock)
    rmSync(sock)
    writeFileSync(sock, '')
    w.writeTimerFile({
      sessionId: 'reused',
      timerPid: process.pid,
      claudePid: process.pid,
      socketPath: sock,
      socketInode: mine,
      token: 't',
      cwd: '/home/user/project-a',
      transcriptPath: join(tempDir, 'x.jsonl'),
      armedAt: 1_000,
      firesAt: 2_000,
    } as never)
    w.sweepTimerFiles()
    expect(existsSync(w.timerFilePath('reused')!)).toBe(false)
  })
})

describe('the timer file\'s permissions', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-timer-mode-'))
  })
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    vi.doUnmock('node:os')
  })

  const file = {
    sessionId: 'modes',
    timerPid: process.pid,
    claudePid: process.pid,
    socketPath: '/tmp/cc-socks/1.sock',
    token: 'secret-token',
    cwd: '/home/user/project-a',
    transcriptPath: '/home/user/.claude/projects/p/modes.jsonl',
    armedAt: 1_000,
    firesAt: 2_000,
  }

  it('tightens a file that was already there with looser permissions', async () => {
    // writeFileSync's mode applies at creation only, so an existing file
    // keeps whatever it had. The file carries a live auth token.
    const w = await importFresh(tempDir)
    w.writeTimerFile(file as never)
    chmodSync(w.timerFilePath('modes')!, 0o644)
    w.writeTimerFile(file as never)
    expect(statSync(w.timerFilePath('modes')!).mode & 0o777).toBe(0o600)
  })

  it('keeps the directory to its owner too, even one that was already there', async () => {
    // mkdirSync's mode has the same creation-only weakness, and the directory
    // this feature shipped with was created 0755.
    const w = await importFresh(tempDir)
    mkdirSync(w.TIMERS_DIR, { recursive: true })
    chmodSync(w.TIMERS_DIR, 0o755)
    w.writeTimerFile(file as never)
    expect(statSync(w.TIMERS_DIR).mode & 0o777).toBe(0o700)
  })
})

describe('isOurPoller', () => {
  let tempDir: string
  let child: ReturnType<typeof spawn> | null

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-poller-id-'))
    child = null
  })
  afterEach(() => {
    child?.kill('SIGKILL')
    rmSync(tempDir, { recursive: true, force: true })
    vi.doUnmock('node:os')
  })

  /** A real process whose command line looks like a poller for `sessionId`. */
  function poller(sessionId: string): number {
    const entry = join(tempDir, 'idle-timer.js')
    writeFileSync(entry, 'setTimeout(() => {}, 30_000)')
    child = spawn(process.execPath, [entry, sessionId], { stdio: 'ignore' })
    return child.pid!
  }

  it('recognises this session\'s own poller', async () => {
    const w = await importFresh(tempDir)
    expect(w.isOurPoller(poller('sess-mine'), 'sess-mine')).toBe(true)
  })

  it('refuses another session\'s poller, which the name alone would accept', async () => {
    // SessionEnd signals what this says yes to. Matching 'idle-timer' alone
    // makes every poller on the machine look like this session's own, and the
    // one thing worse than failing to stop your own timer is killing
    // somebody else's.
    const w = await importFresh(tempDir)
    expect(w.isOurPoller(poller('sess-theirs'), 'sess-mine')).toBe(false)
  })

  it('refuses a process that is not a poller at all', async () => {
    const w = await importFresh(tempDir)
    expect(w.isOurPoller(process.pid, 'sess-mine')).toBe(false)
  })

  it('refuses a pid that owns nothing', async () => {
    const w = await importFresh(tempDir)
    expect(w.isOurPoller(4_194_304, 'sess-mine')).toBe(false)
  })

  it('refuses an empty session id, which would otherwise match anything', async () => {
    const w = await importFresh(tempDir)
    expect(w.isOurPoller(poller('sess-mine'), '')).toBe(false)
  })
})
