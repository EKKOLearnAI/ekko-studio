import { describe, expect, it, vi } from 'vitest'
import { AgentBridgeClient } from '../../packages/server/src/modules/hermes/services/bridge/client'

describe('Hermes context manager client contract', () => {
  it.each([false, true])('passes settings and native conversation identity with fallback=%s', async (allowNativeFallback) => {
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1' })
    const request = vi.spyOn(client, 'request').mockResolvedValue({ ok: true })
    const context_manager = { manager: 'bili' as const, proxyUrl: 'http://localhost:2345', allowNativeFallback, conversationId: 's' }
    await client.chat('s', 'raw message', [{ role: 'user', content: 'raw history' }], undefined, 'p', { context_manager })
    await client.contextEstimate('s', [], undefined, 'p', { context_manager })
    await client.contextManagerStatus('s', 'p', { context_manager })
    expect(request.mock.calls.map(([payload]) => payload)).toEqual([
      expect.objectContaining({ action: 'chat', session_id: 's', profile: 'p', context_manager }),
      expect.objectContaining({ action: 'context_estimate', session_id: 's', profile: 'p', context_manager }),
      { action: 'context_manager_status', session_id: 's', profile: 'p', context_manager },
    ])
  })
})