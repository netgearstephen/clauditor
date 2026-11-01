import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeConfigDir, claudeSessionsDir } from './claude-dir.js'

describe('claudeConfigDir', () => {
  it('follows CLAUDE_CONFIG_DIR when set', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/x/.claude-dev' })).toBe('/x/.claude-dev')
  })
  it('expands a leading ~', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '~/.claude-dev' })).toBe(
      resolve(homedir(), '.claude-dev')
    )
  })
  it('falls back to ~/.claude when unset or empty', () => {
    expect(claudeConfigDir({})).toBe(resolve(homedir(), '.claude'))
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '' })).toBe(resolve(homedir(), '.claude'))
  })
  it('puts sessions under the config dir', () => {
    expect(claudeSessionsDir({ CLAUDE_CONFIG_DIR: '/x/c' })).toBe('/x/c/sessions')
  })
})
