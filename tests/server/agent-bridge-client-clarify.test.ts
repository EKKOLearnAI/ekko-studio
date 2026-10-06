import { describe, expect, it, vi } from 'vitest'

describe('AgentBridgeClient clarify responses', () => {
  it('sends clarify_respond requests to the bridge', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request').mockResolvedValue({ ok: true, resolved: true })

    await expect(client.clarifyRespond('clarify-1', 'Use the first option')).resolves.toEqual({
      ok: true,
      resolved: true,
    })

    expect(request).toHaveBeenCalledWith({
      action: 'clarify_respond',
      clarify_id: 'clarify-1',
      response: 'Use the first option',
    })

    await client.clarifyRespond('clarify-1', 'Use the first option', { q0: 'Use the first option', q1: null })
    expect(request).toHaveBeenLastCalledWith({
      action: 'clarify_respond',
      clarify_id: 'clarify-1',
      response: 'Use the first option',
      answers: { q0: 'Use the first option', q1: null },
    })
  })
})
