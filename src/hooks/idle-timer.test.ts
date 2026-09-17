import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'

async function importFresh(tempDir: string) {
  vi.resetModules()
  vi.doMock('node:os', () => ({ homedir: () => tempDir }))
  return {
    timer: await import('./idle-timer.js'),
    w: await import('../features/idle-watchdog.js'),
  }
}

const CWD = '/home/user/project-a'

/** A transcript whose last turn is `ageMs` old and whose peak is `peak`. */
function transcript(dir: string, ageMs: number, peak: number): string {
  const path = join(dir, 'idle.jsonl')
  const ts = new Date(Date.now() - ageMs).toISOString()
  const recs = [
    { type: 'user', cwd: CWD, timestamp: ts },
    {
      type: 'assistant',
      timestamp: ts,
      message: {
        model: 'claude-opus-5',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: peak - 10,
        },
      },
    },
  ]
  writeFileSync(path, recs.map((r) => JSON.stringify(r)).join('\n'))
  return path
}

/**
 * The same transcript, but ending on a tool call nothing answered: the shape
 * a session parked on a permission prompt leaves behind.
 */
function parkedTranscript(dir: string, ageMs: number, peak: number): string {
  const path = transcript(dir, ageMs, peak)
  const ts = new Date(Date.now() - ageMs).toISOString()
  appendFileSync(
    path,
    `\n${JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      message: {
        model: 'claude-opus-5',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: peak - 10,
        },
        content: [{ type: 'tool_use', id: 'parked', name: 'Bash', input: {} }],
      },
    })}`
  )
  return path
}

describe('the idle timer', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-idle-'))
  })
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    vi.doUnmock('node:os')
  })

  /**
   * Publish the key file Claude Code writes for a live session, which is
   * where the poller now reads its peer token from.
   */
  function publishPeerToken(sockPath: string, peerToken = 'peer-secret') {
    const dir = join(tempDir, '.claude', 'sessions')
    mkdirSync(dir, { recursive: true })
    const pid = Number(sockPath.match(/(\d+)\.sock$/)![1])
    const hash = createHash('sha256').update(sockPath).digest('hex')
    writeFileSync(join(dir, `${pid}.${hash}.key`), JSON.stringify({ peerToken }))
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, name: 'clauditor-x1' }))
  }

  async function arm(over: Record<string, unknown> = {}) {
    const { timer, w } = await importFresh(tempDir)
    const cfg = await import('../config.js')
    // These synthetic transcripts carry a single turn to keep the fixtures
    // simple, well under the default twenty-request anti-thrash floor, so it
    // is cleared here. A test after this one that writes its own config (the
    // stand-down case below) replaces the file outright and this has no say.
    cfg.writeConfig({ rotation: { trigger: { minRequestsSinceBank: 0 } } } as never)
    // Named for a pid, as Claude Code names them: readInboxAuth finds the
    // session's key file by the pid in its socket path.
    const sockPath = join(tempDir, `${process.pid}.sock`)
    if (over.publishToken !== false) publishPeerToken(sockPath)
    delete over.publishToken
    const received: string[] = []
    const server = createServer((c) => {
      c.on('data', (b) => received.push(...b.toString().split('\n').filter(Boolean)))
    })
    await new Promise<void>((r) => server.listen(sockPath, r))
    // The default transcript is only written when the caller has not already
    // supplied its own: writing it unconditionally here would run after an
    // override's transcript() call and clobber that file's content.
    const transcriptPath = (over.transcriptPath as string | undefined) ?? transcript(tempDir, 56 * 60 * 1000, 300_000)
    w.writeTimerFile({
      sessionId: 'idle-1',
      timerPid: process.pid,
      claudePid: process.pid,
      socketPath: sockPath,
      token: 'tok',
      cwd: CWD,
      transcriptPath,
      armedAt: Date.now() - 56 * 60 * 1000,
      firesAt: Date.now() - 60_000,
      ...over,
    } as never)
    return { timer, w, server, received }
  }

  it('waits while the fire time is still ahead', async () => {
    const { timer, server } = await arm({ firesAt: Date.now() + 600_000 })
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('waiting')
    server.close()
  })

  it('pushes the fire time out to the last real turn instead of deleting itself', async () => {
    // The whole of Stephen's symptom: firesAt was fixed at armedAt + 55min,
    // so the one check that followed found a turn had landed, logged it,
    // deleted the timer file and exited. One check per session, ever, after
    // which an idle session had no timer and no poller at all.
    const { timer, w, server } = await arm({
      transcriptPath: transcript(tempDir, 5 * 60 * 1000, 300_000),
    })
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('waiting')
    server.close()
    const file = w.readTimerFile('idle-1')
    expect(file).not.toBeNull()
    // Re-derived from the last real turn, not from armedAt: five minutes of
    // idle so far, so fifty still to go.
    expect(file!.firesAt - Date.now()).toBeGreaterThan(49 * 60 * 1000)
    expect(file!.firesAt - Date.now()).toBeLessThanOrEqual(50 * 60 * 1000)
  })

  it('keeps the poller alive across a push-out, so the session is still watched', async () => {
    // 'waiting' is what main() loops on. 'nothing' is what ends it.
    const { timer, w, server } = await arm({
      transcriptPath: transcript(tempDir, 60_000, 300_000),
    })
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('waiting')
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('waiting')
    server.close()
    expect(w.readTimerFile('idle-1')).not.toBeNull()
  })

  it('deletes the timer on a stand-down that waiting cannot change', async () => {
    // Rotation off will not become rotation on by being waited on, and a
    // poller that outlives its purpose is a poller nobody swept.
    const { timer, w, server } = await arm()
    const cfg = await import('../config.js')
    cfg.writeConfig({
      rotation: { enabled: false, minPeakContext: 200_000, reBankGrowth: 50_000, blockAfterBank: true },
      notifications: { desktop: true },
    })
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('nothing')
    server.close()
    expect(w.readTimerFile('idle-1')).toBeNull()
  })

  it('sends the bank request the Stop hook would have sent', async () => {
    const { timer, server, received } = await arm()
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('bank')
    await new Promise((r) => setTimeout(r, 50))
    server.close()
    expect(JSON.parse(received[0]).type).toBe('auth')
    expect(received[1]).toContain('cheapest moment')
  })

  it('states a deadline on the wake, measured from the last real turn', async () => {
    // Without it, a wake queued behind a prompt is read whenever the human
    // comes back and spends full price on a cache that expired hours ago.
    const { timer, server, received } = await arm()
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('bank')
    await new Promise((r) => setTimeout(r, 50))
    server.close()
    const sent = received[1]
    expect(sent).toContain('this request was queued at')
    // The transcript's last turn is 56 minutes old against a 60-minute TTL,
    // so the window the woken turn has is the four minutes left of it.
    const deadline = Date.parse(sent.match(/until (\S+Z)/)![1])
    expect(deadline - Date.now()).toBeGreaterThan(3 * 60 * 1000)
    expect(deadline - Date.now()).toBeLessThanOrEqual(4 * 60 * 1000)
  })

  it('sends nothing to a session parked on a prompt', async () => {
    // Warm, large, unbanked and still listening, and none of that helps: the
    // turn has not ended, so the wake would queue behind whatever the session
    // is asking its human and be read long after the cache had gone.
    const { timer, w, server, received } = await arm({
      transcriptPath: parkedTranscript(tempDir, 56 * 60 * 1000, 300_000),
    })
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('notify')
    await new Promise((r) => setTimeout(r, 50))
    server.close()
    expect(received).toEqual([])
    expect(w.readTimerFile('idle-1')).toBeNull()
    const activity = await import('../features/activity-log.js')
    const events = await activity.readActivity()
    expect(events.some((e) => e.message.includes('parked-on-prompt'))).toBe(true)
  })

  it('leaves the bank stamps alone when it stands down on a park', async () => {
    // The stamps are what stop the session asking again. Writing them for a
    // request that was never sent would retire banking for a session that is
    // about to answer its prompt and carry on working.
    const { timer, server } = await arm({
      transcriptPath: parkedTranscript(tempDir, 56 * 60 * 1000, 300_000),
    })
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('notify')
    server.close()
    const journal = await import('../features/journal.js')
    expect(journal.readJournalState(CWD).bankRequestedAt).toBe(0)
    expect(journal.readSessionBank('idle-1')).toBeNull()
  })

  it("authenticates with the session's peer token, not the one armed into the file", async () => {
    // The timer file used to carry CLAUDE_CODE_MESSAGING_TOKEN, the
    // childToken, which a detached poller cannot use: it reparents to
    // launchd and stops being a child long before it fires.
    const { timer, server, received } = await arm()
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('bank')
    await new Promise((r) => setTimeout(r, 50))
    server.close()
    expect(JSON.parse(received[0]).token).toBe('peer-secret')
  })

  it('logs a bank it could not send when the session has taken its key file away', async () => {
    // A session that exited between arming and firing leaves the socket path
    // behind but not the key, and an unauthenticated send is silently
    // dropped, so there would otherwise be no record of the attempt at all.
    const { timer, server } = await arm({ publishToken: false })
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('bank')
    server.close()
    const activity = await import('../features/activity-log.js')
    const events = await activity.readActivity()
    expect(
      events.some((e) => e.message === 'idle bank could not be sent at 300000 peak context')
    ).toBe(true)
  })

  it('logs a bank sent, claiming no more than the write proves', async () => {
    const { timer, server } = await arm()
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('bank')
    server.close()
    const activity = await import('../features/activity-log.js')
    const events = await activity.readActivity()
    expect(events.some((e) => e.message === 'idle bank sent at 300000 peak context')).toBe(true)
  })

  it('logs a bank it could not send, so a refused connection is still auditable', async () => {
    // A plain file, not a socket, satisfies existsSync (so shouldIdleBank
    // still reaches 'bank') but refuses the connection sendToInbox attempts,
    // giving sent === false without ever touching the 'notify' path.
    const fakeSocket = join(tempDir, 'fake.sock')
    writeFileSync(fakeSocket, '')
    const { timer, server } = await arm({ socketPath: fakeSocket })
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('bank')
    server.close()
    const activity = await import('../features/activity-log.js')
    const events = await activity.readActivity()
    expect(
      events.some((e) => e.message === 'idle bank could not be sent at 300000 peak context')
    ).toBe(true)
  })

  it('records the request, so an unanswered one does not re-fire at every stop', async () => {
    const { timer, w, server } = await arm()
    await timer.runIdleTimerOnce('idle-1')
    server.close()
    const j = await import('../features/journal.js')
    expect(j.readJournalState(CWD).bankRequestedSession).toBe('idle-1')
  })

  it('flags the bank as unattended, so the session is not left blocked', async () => {
    const { timer, server } = await arm()
    await timer.runIdleTimerOnce('idle-1')
    server.close()
    const j = await import('../features/journal.js')
    expect(j.takeUnattendedBank(CWD, 'idle-1')).toBe(true)
  })

  it('stamps the request on the session marker, so a woken re-bank can answer it', async () => {
    // The Stop hook writes recordBankRequest and markBankRequested together.
    // The second is what stands the wind-down guard aside for the Write the
    // bank instruction asks for, so a woken re-bank without it is told to
    // write a handoff and then refused the tool to write it with.
    const { timer, server } = await arm()
    const j = await import('../features/journal.js')
    j.markSessionBanked('idle-1', CWD, Date.now() - 60_000, {
      peakContext: 100_000,
      handoffPath: join(tempDir, 'handoff.md'),
    })
    expect(j.isBlockedAfterBank('idle-1', 'Write')).toBe(true)

    expect(await timer.runIdleTimerOnce('idle-1')).toBe('bank')
    server.close()
    expect(j.isBlockedAfterBank('idle-1', 'Write')).toBe(false)
  })

  it('writes its stamps where the session is now, not where it was armed', async () => {
    // The arm-time cwd is up to 55 minutes old, while the Stop hook that
    // handles the request reads the flag under its own current cwd. A session
    // that changed directory in between writes the flag in one place and
    // looks for it in another, and comes back to a guard it never armed.
    const { timer, server } = await arm({ cwd: '/home/user/where-it-was-armed' })
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('bank')
    server.close()

    const j = await import('../features/journal.js')
    expect(j.readJournalState(CWD).bankRequestedSession).toBe('idle-1')
    expect(j.takeUnattendedBank(CWD, 'idle-1')).toBe(true)
    expect(j.takeUnattendedBank('/home/user/where-it-was-armed', 'idle-1')).toBe(false)
  })

  it('says nothing to a socket path that now belongs to another session', async () => {
    // Sockets are keyed by pid. If the original claude exited and a new one
    // took that pid, the path still exists and the wake would be delivered to
    // a stranger's session.
    const { timer, w, server, received } = await arm({ socketInode: 999_999_999 })
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('nothing')
    await new Promise((r) => setTimeout(r, 50))
    server.close()
    expect(received).toEqual([])
    expect(existsSync(w.timerFilePath('idle-1')!)).toBe(false)
  })

  it('still acts on a timer file written before the inode was recorded', async () => {
    // Every file already on disk has no inode field. Reading absence as a
    // mismatch would strand all of them.
    const { timer, server } = await arm()
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('bank')
    server.close()
  })

  it('does not send anything to a session that has taken a turn since arming', async () => {
    // 'waiting', not 'nothing': the firing is cancelled but the watch is not.
    const { timer, server, received } = await arm({
      transcriptPath: transcript(tempDir, 60_000, 300_000),
    })
    expect(await timer.runIdleTimerOnce('idle-1')).toBe('waiting')
    server.close()
    expect(received).toEqual([])
  })

  it('deletes its own file once it has acted', async () => {
    const { timer, w, server } = await arm()
    await timer.runIdleTimerOnce('idle-1')
    server.close()
    expect(existsSync(w.timerFilePath('idle-1')!)).toBe(false)
  })

  it('logs a stood-down session, so an unattended silence is still auditable', async () => {
    const { timer, server } = await arm()
    const cfg = await import('../config.js')
    // Rotation disabled is the cheapest way to reach shouldIdleBank's
    // 'nothing' branch without needing a live bank or a particular growth.
    cfg.writeConfig({
      rotation: { enabled: false, minPeakContext: 200_000, reBankGrowth: 50_000, blockAfterBank: true },
      notifications: { desktop: true },
    })

    expect(await timer.runIdleTimerOnce('idle-1')).toBe('nothing')
    server.close()

    const activity = await import('../features/activity-log.js')
    const events = await activity.readActivity()
    expect(events.some((e) => e.message.includes('idle timer stood down'))).toBe(true)
  })

  it('stands down a session that has not cleared the default request floor', async () => {
    // arm() clears the floor by default so the rest of this file's single-
    // turn transcripts stay eligible; this test restores the real default to
    // prove the wiring (the subtraction, the journal read, the resolved
    // trigger) actually reaches shouldIdleBank rather than always being
    // cleared before it matters.
    const { timer, server } = await arm()
    const cfg = await import('../config.js')
    cfg.writeConfig({ rotation: { trigger: { minRequestsSinceBank: 20 } } } as never)

    // The floor only reaches a session that has banked here before, so this
    // one is given a bank of its own to be held back from. Without it the
    // floor resolves to zero and the wiring under test is never exercised.
    const journal = await import('../features/journal.js')
    journal.writeJournalState(CWD, {
      ...journal.readJournalState(CWD),
      bankedAt: Date.now(),
      bankedAtTurn: 0,
      bankedSession: 'idle-1',
    })

    expect(await timer.runIdleTimerOnce('idle-1')).toBe('nothing')
    server.close()

    const activity = await import('../features/activity-log.js')
    const events = await activity.readActivity()
    expect(events.some((e) => e.message.includes('too few requests since the last bank'))).toBe(true)
  })

  it('logs a session it declines to wake into a cold cache, so the silence is auditable', async () => {
    const { CACHE_TTL_MS } = await import('../features/journal.js')
    const { timer, server } = await arm({
      transcriptPath: transcript(tempDir, CACHE_TTL_MS + 60_000, 300_000),
    })

    expect(await timer.runIdleTimerOnce('idle-1')).toBe('notify')
    server.close()

    const activity = await import('../features/activity-log.js')
    const events = await activity.readActivity()
    expect(events.some((e) => e.message.includes('cache-cold'))).toBe(true)
  })
})

describe('awaitOwnArming', () => {
  let tempDir: string
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-idle-startup-'))
  })
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    vi.doUnmock('node:os')
  })

  // Closes the spawn/write race described in the plan: the parent writes the
  // timer file (naming this process's pid) only after spawning it, so the
  // poller's very first read can land before that write does. This is the
  // wait that stands in for that gap.
  it('returns true once the timer file comes to name this pid', async () => {
    const { timer, w } = await importFresh(tempDir)
    setTimeout(() => {
      w.writeTimerFile({
        sessionId: 'startup-1',
        timerPid: process.pid,
        claudePid: process.pid,
        socketPath: join(tempDir, 'inbox.sock'),
        token: 'tok',
        cwd: CWD,
        transcriptPath: transcript(tempDir, 0, 1_000),
        armedAt: Date.now(),
        firesAt: Date.now() + 1_000,
      } as never)
    }, 100)

    expect(await timer.awaitOwnArming('startup-1', 2_000)).toBe(true)
  })

  it('gives up once the grace has elapsed and the file still does not name it', async () => {
    const { timer } = await importFresh(tempDir)
    expect(await timer.awaitOwnArming('nobody-waiting', 200)).toBe(false)
  })

  it('does not wait past the grace once a later mismatch shows up', async () => {
    // Not this function's job once the poller is past startup: main's own
    // per-loop check (unchanged) is what exits on a later supersession. This
    // only pins that awaitOwnArming itself does not grant a second grace.
    const { timer, w } = await importFresh(tempDir)
    w.writeTimerFile({
      sessionId: 'startup-2',
      timerPid: process.pid + 1,
      claudePid: process.pid,
      socketPath: join(tempDir, 'inbox.sock'),
      token: 'tok',
      cwd: CWD,
      transcriptPath: transcript(tempDir, 0, 1_000),
      armedAt: Date.now(),
      firesAt: Date.now() + 1_000,
    } as never)
    const start = Date.now()
    expect(await timer.awaitOwnArming('startup-2', 300)).toBe(false)
    expect(Date.now() - start).toBeGreaterThanOrEqual(300)
  })
})
