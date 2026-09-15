import { readStdin, isHookEntry } from './shared.js'
import { allowWorkAfterBank } from '../features/journal.js'

/**
 * UserPromptSubmit hook — fires before Claude processes the user's prompt.
 *
 * This hook is now inert, and that is deliberate.
 *
 * It used to do two things, and both were interruptions of the user rather
 * than of the model. It blocked the prompt outright when the session's waste
 * factor crossed a threshold, and it blocked again when the prompt looked like
 * "continue" so it could inject a handoff. Between them they were two of the
 * four separate paths that could interrupt a session, each writing a different
 * format to a different place.
 *
 * Both are gone. Rotation is handled by the Stop hook, which banks a handoff
 * while the prompt cache is still warm and never stops the user typing, and
 * resumption is handled by SessionStart, which offers exactly one summary.
 * Blocking a prompt before it runs is the most disruptive thing clauditor
 * could do and it fired at precisely the moment the user had decided what they
 * wanted to say.
 *
 * The handler is kept rather than deleted so that an installed hook
 * configuration pointing at it keeps working, and existing installs do not
 * start erroring on upgrade.
 *
 * It now reads one thing out of the prompt and still blocks nothing: whether
 * the user said anything at all. The wind-down guard in PreToolUse has to be
 * liftable by the user, and this is the only hook that sees that they spoke.
 * It does not read what they said, which is the point: nothing here can be
 * triggered by quoting, relaying or discussing a phrase. It never refuses a
 * prompt, never injects context, and never delays anything: it sets a flag and
 * gets out of the way.
 */
export async function handleUserPromptSubmitHook(): Promise<void> {
  const raw = await readStdin().catch(() => '')
  try {
    const input = JSON.parse(raw) as { session_id?: string; prompt?: string }
    // Any prompt at all. The user typing again IS the decision to carry on,
    // and a phrase they had to know was only ever a trap for the person who
    // did not know it. It also handed a blocked agent the incantation, which
    // is how the guard once came off without the user saying anything.
    // Stephen: "Having a specific phrase that is needed is stupid."
    if (input.prompt && input.prompt.trim() !== '') {
      allowWorkAfterBank(input.session_id ?? null)
    }
  } catch {}
  process.stdout.write('{}')
}

// Run only when this module is the entry point: see isHookEntry.
if (isHookEntry('user-prompt-submit')) {
  handleUserPromptSubmitHook().catch(() => {
    process.stdout.write('{}')
    process.exit(0)
  })
}
