import { describe, expect, it } from 'vitest'
import { groupRunUsageMessage, parseGroupRunUsage } from '../../packages/server/src/modules/studio/services/group-chat/run-usage'

const usage = { runId: 'runtime-run', assistantMessageId: 'runtime-message', inputTokens: 1200, outputTokens: 200,
  cacheReadTokens: 300, cacheHitRate: 0.25, costUsd: 0.0123, tokensPerSecond: 50, speedSource: 'model', isEstimated: false }

describe('group run usage transport', () => {
  it('keeps one stable card per room/session/run and rebases the runtime identity', () => {
    const first = groupRunUsageMessage('room', 'session', 'group-run', 'group-reply', usage)!
    const updated = groupRunUsageMessage('room', 'session', 'group-run', 'group-reply', { ...usage, outputTokens: 250 })!
    expect(updated.id).toBe(first.id)
    expect(JSON.parse(updated.content)).toMatchObject({ runId: 'group-run', assistantMessageId: 'group-reply', outputTokens: 250 })
    expect(first.extra).toMatchObject({ role: 'tool', tool_name: 'run_usage', run_id: 'group-run' })
    expect(groupRunUsageMessage('room', 'other-session', 'group-run', 'group-reply', usage)!.id).not.toBe(first.id)
  })

  it('preserves measured zero and keeps unavailable metrics unknown', () => {
    expect(parseGroupRunUsage({ ...usage, inputTokens: 0, costUsd: 0, outputTokens: -1,
      cacheReadTokens: '300', tokensPerSecond: Infinity, cacheHitRate: 2 }))
      .toMatchObject({ inputTokens: 0, costUsd: 0, outputTokens: null, cacheReadTokens: null, tokensPerSecond: null, cacheHitRate: null })
    for (const raw of ['bad JSON', null, [], { runId: '' }]) expect(parseGroupRunUsage(raw)).toBeNull()
  })
})
