import { readStdin, isHookEntry } from './shared.js'

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
 */
export async function handleUserPromptSubmitHook(): Promise<void> {
  await readStdin().catch(() => '')
  process.stdout.write('{}')
}

// Run only when this module is the entry point: see isHookEntry.
if (isHookEntry('user-prompt-submit')) {
  handleUserPromptSubmitHook().catch(() => {
    process.stdout.write('{}')
    process.exit(0)
  })
}
