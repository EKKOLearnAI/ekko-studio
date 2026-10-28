import { describe, expect, it, vi } from 'vitest'
import { studioModelReasoningEffort } from '../../packages/server/src/modules/studio/public/model-reasoning-effort'
import { AgentBridgeClient } from '../../packages/server/src/modules/hermes/services/bridge/client'

vi.mock('../../packages/server/src/modules/studio/public/model-catalog', async original => ({
  ...await original<typeof import('../../packages/server/src/modules/studio/public/model-catalog')>(),
  getModelCatalog: () => ({ test: { models: {
    sol: { id: 'sol', reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }] },
    constrained: { id: 'constrained', reasoning: true, reasoning_options: [{ type: 'effort', values: ['high', 'medium'] }] },
    fast: { id: 'fast', reasoning: false },
  } } }),
}))

describe('runtime reasoning capabilities', () => {
  it.each([
    { model: 'sol', selected: '', expected: 'low' },
    { model: 'sol', selected: 'none', expected: 'low' },
    { model: 'sol', selected: 'xhigh', expected: 'xhigh' },
    { model: 'constrained', selected: '', expected: 'medium' },
    { model: 'fast', selected: 'xhigh', expected: undefined },
  ])('uses catalog capabilities for $model ($selected)', async ({ model, selected, expected }) => {
    expect(studioModelReasoningEffort({ provider: 'test', model, reasoningEffort: selected })).toBe(expected)
    // Group Hermes runs call this bridge directly; single chat and workflows also converge here.
    const bridge = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1' })
    const request = vi.spyOn(bridge, 'request').mockResolvedValue({ ok: true })
    await bridge.chat('session', 'hello', undefined, undefined, 'default', { provider: 'test', model, reasoning_effort: selected })
    const body = request.mock.calls[0][0] as Record<string, unknown>
    expect(body.reasoning_effort).toBe(expected)
    if (!expected) expect(body).not.toHaveProperty('reasoning_effort')
  })
})
