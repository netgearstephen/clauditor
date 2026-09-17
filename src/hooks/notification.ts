import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { armIdleTimer } from '../features/idle-watchdog.js'
import { isHookEntry, readStdin } from './shared.js'

/** All this hook reads. Notification carries more; none of it is needed. */
export interface NotificationHookInput {
  session_id?: string
  transcript_path?: string
}

/**
 * Arm the idle timer when the session parks waiting for a human.
 *
 * The second arming point, and the only one that sees a park. Stop fires when
 * a turn ends, and a turn waiting on a permission prompt or a question has
 * not ended: the session can sit there for hours with no Stop, and one that
 * parks before its first Stop has no poller at all, so the 55-minute wake
 * never happens and the cache goes cold unbanked. Notification fires on
 * exactly that, so it is where the window gets measured from.
 *
 * Nothing is decided here and nothing is sent. Notification has no decision
 * semantics to abuse, which is the reason it was chosen over the other events
 * that fire at a park: this writes a timer file and exits.
 */
export async function handleNotificationHook(
  input: NotificationHookInput | null
): Promise<void> {
  if (!input?.session_id) return
  armIdleTimer({
    sessionId: input.session_id,
    transcriptPath: input.transcript_path,
    here: dirname(fileURLToPath(import.meta.url)),
  })
}

// Run only when this module is the entry point: see isHookEntry.
if (isHookEntry('notification')) {
  readStdin()
    .then((raw) => handleNotificationHook(JSON.parse(raw)))
    .catch(() => {})
    .finally(() => {
      process.stdout.write('{}')
      process.exit(0)
    })
}
