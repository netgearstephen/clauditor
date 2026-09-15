import { isHookEntry, readStdin } from './shared.js'
import {
  deleteTimerFile,
  isOurPoller,
  isProcessAlive,
  readTimerFile,
} from '../features/idle-watchdog.js'

/**
 * Stop this session's idle timer on a clean exit.
 *
 * The normal path, and the only one that is prompt. A SIGKILL, a crash or a
 * terminal closed from under the process never gets here, which is what the
 * poller's own socket check and the sweep on arming are for.
 *
 * A pid alive under the timer file's name is not enough to signal: it may
 * have been recycled onto an unrelated process since the poller that held it
 * exited, or onto another session's poller, so `isOurPoller` confirms
 * identity, name and session id both, before anything is killed. A mismatch
 * still gets the file removed; it just is not signalled.
 */
export async function handleSessionEndHook(
  input: { session_id?: string } | null
): Promise<void> {
  const sessionId = input?.session_id
  if (!sessionId) return
  const file = readTimerFile(sessionId)
  if (!file) return
  if (file.timerPid && isProcessAlive(file.timerPid) && isOurPoller(file.timerPid, sessionId)) {
    try {
      process.kill(file.timerPid)
    } catch {}
  }
  deleteTimerFile(sessionId)
}

// Run only when this module is the entry point: see isHookEntry.
if (isHookEntry('session-end')) {
  readStdin()
    .then((raw) => handleSessionEndHook(JSON.parse(raw)))
    .catch(() => {})
    .finally(() => {
      process.stdout.write('{}')
      process.exit(0)
    })
}
