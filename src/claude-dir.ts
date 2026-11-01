import { homedir } from 'node:os'
import { resolve } from 'node:path'

/**
 * Claude Code's config dir: CLAUDE_CONFIG_DIR when a session was launched
 * with one, else ~/.claude. Transcripts, sessions and the inbox key files
 * all live under it.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CLAUDE_CONFIG_DIR
  if (!raw) return resolve(homedir(), '.claude')
  return raw === '~' || raw.startsWith('~/') ? resolve(homedir(), raw.slice(2)) : resolve(raw)
}

export function claudeSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(claudeConfigDir(env), 'sessions')
}

export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(claudeConfigDir(env), 'projects')
}
