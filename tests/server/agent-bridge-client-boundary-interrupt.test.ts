import { describe, expect, it, vi } from 'vitest'

describe('AgentBridgeClient boundary interrupts', () => {
  it('routes cancellation to the same profile and run generation', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1' })
    const request = vi.spyOn(client, 'request').mockResolvedValue({ ok: true, status: 'cancelled' })
    await client.cancelBoundaryInterrupt('session-1', 'run-1', 'work')
    expect(request).toHaveBeenCalledWith({
      action: 'cancel_boundary_interrupt', session_id: 'session-1', expected_run_id: 'run-1', profile: 'work',
    })
  })
  it('forwards the expected run ID and profile to the Hermes Bridge', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request').mockResolvedValue({
      ok: true,
      status: 'accepted',
      session_id: 'session-1',
      run_id: 'run-1',
      phase: 'tool_batch',
      guarantee: 'strict',
    })

    const result = await client.requestBoundaryInterrupt('session-1', 'run-1', 'work')

    expect(request).toHaveBeenCalledWith({
      action: 'request_boundary_interrupt',
      session_id: 'session-1',
      expected_run_id: 'run-1',
      profile: 'work',
    })
    expect(result).toMatchObject({
      status: 'accepted',
      run_id: 'run-1',
      phase: 'tool_batch',
      guarantee: 'strict',
    })
  })

  it('omits optional routing fields when they are unavailable', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request').mockResolvedValue({
      ok: true,
      status: 'not_running',
      session_id: 'session-2',
      guarantee: 'strict',
    })

    await client.requestBoundaryInterrupt('session-2')

    expect(request).toHaveBeenCalledWith({
      action: 'request_boundary_interrupt',
      session_id: 'session-2',
    })
  })
})
