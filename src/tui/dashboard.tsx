import React from 'react'
import { Box, Text } from 'ink'
import type { SessionState } from '../types.js'
import { estimateCost, getPricingForModel } from '../features/cost-tracker.js'
import { peakContextTokens } from '../features/journal.js'
import { resolveTrigger } from '../features/trigger.js'

interface DashboardProps {
  session: SessionState
}

export function Dashboard({ session }: DashboardProps) {
  const pricing = session.model ? getPricingForModel(session.model) : undefined
  const cost = estimateCost(session.totalUsage, pricing)
  const modelShort = session.model?.replace('claude-', '').split('-2')[0] || 'unknown'

  // Peak context against the banking gate. Peak rather than current, because
  // a session that compacts drops back down while the cold rewrite a handoff
  // avoids is still priced on the high-water mark. Resolved against this
  // session's model, so a per-model override and the window clamp show up in
  // the bar rather than only in the decision.
  const peak = peakContextTokens(session.turns)
  const gate = resolveTrigger(session.model ?? null).gate
  const banked = peak >= gate

  const barWidth = 30
  const filled = Math.round(Math.min(1, peak / gate) * barWidth)
  const peakBar = '█'.repeat(filled) + '░'.repeat(barWidth - filled)
  const barColor = banked ? 'green' : peak >= gate * 0.7 ? 'yellow' : 'blue'

  // Cache status
  const cacheRatio = session.cacheHealth.lastCacheRatio
  const cacheOk = cacheRatio >= 0.7

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1}>
        <Text>
          <Text bold>{session.label}</Text>
          {'  '}
          <Text dimColor>{modelShort} · {session.turns.length} turns</Text>
        </Text>
      </Box>

      {/* Peak context — what decides whether a handoff gets banked */}
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text bold>Peak context: {(peak / 1000).toFixed(0)}k</Text>
          {'  '}
          {banked ? (
            <Text color="green" bold>handoff banked while warm</Text>
          ) : (
            <Text color="blue">below the {(gate / 1000).toFixed(0)}k banking gate</Text>
          )}
        </Text>
        <Text color={barColor}>{peakBar}</Text>
        <Text dimColor>
          A handoff is banked once at {(gate / 1000).toFixed(0)}k, read back at 0.1x
          rather than rewritten at 2x. Nothing is ever blocked.
        </Text>
      </Box>

      {/* Secondary metrics — one line */}
      <Text>
        Cache: <Text color={cacheOk ? 'green' : 'red'}>{(cacheRatio * 100).toFixed(0)}%</Text>
        {'  '}
        Turns: {session.turns.length}
        {'  '}
        <Text dimColor>~${cost.totalCost.toFixed(0)} API est.</Text>
      </Text>

      {/* Alerts — only real problems, not warmup */}
      {!cacheOk && session.turns.length >= 10 && (
        <Box marginTop={1}>
          <Text color="red" bold>
            ● Cache broken — {(cacheRatio * 100).toFixed(0)}% hit rate (should be &gt;70%)
          </Text>
        </Box>
      )}
      {session.loopState.loopDetected && (
        <Box>
          <Text color="red" bold>
            ● Loop — {session.loopState.loopPattern} repeated {session.loopState.consecutiveIdenticalTurns}x
          </Text>
        </Box>
      )}

      {/* How it works — transparency */}
      {session.turns.length < 10 && (
        <Box marginTop={1}>
          <Text dimColor>
            clauditor tracks the peak context this session has been billed for.{'\n'}
            At {(gate / 1000).toFixed(0)}k it spends one warm turn banking a handoff, so
            one is ready if you rotate. It never blocks.
          </Text>
        </Box>
      )}
    </Box>
  )
}
