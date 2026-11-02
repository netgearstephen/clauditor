import { describe, it, expect } from 'vitest'
import { toHookOutput } from './shared.js'

describe('toHookOutput', () => {
  it('nests additionalContext under hookSpecificOutput, the only place the model reads it', () => {
    expect(toHookOutput({ additionalContext: 'nudge' }, 'PostToolUse')).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'nudge' },
    })
  })

  it('keeps the other fields at the top level', () => {
    expect(toHookOutput({ additionalContext: 'k', systemMessage: 's' }, 'SessionStart')).toEqual({
      systemMessage: 's',
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'k' },
    })
  })

  it('nests only the parts deliver accepts, leaving the rest unseen at the top level', () => {
    const deliver = (p: string) => p.startsWith('[clauditor — ROTATION DUE]')
    expect(
      toHookOutput({ additionalContext: 'compressed note\n\n[clauditor — ROTATION DUE]: rotate' }, 'PostToolUse', deliver)
    ).toEqual({
      additionalContext: 'compressed note',
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '[clauditor — ROTATION DUE]: rotate' },
    })
  })

  it('emits no hookSpecificOutput when there is no context to add', () => {
    expect(toHookOutput({}, 'PreToolUse')).toEqual({})
    expect(toHookOutput({ additionalContext: '' }, 'PreToolUse')).toEqual({})
  })
})
