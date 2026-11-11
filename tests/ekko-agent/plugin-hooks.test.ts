import { expect, it, vi } from 'vitest'
import { AgentRuntime, AgentToolRegistry } from '../../packages/ekko-agent/src'
import type { ModelClient } from '../../packages/ekko-agent/src/model/types'
it('authorizes transformed arguments and never lets a result hook override a denial', async () => {
  const authorize = vi.fn(async (_name, input) => ({ approved: input.path === 'allowed', scope: input.path === 'allowed' ? 'safe' as const : 'denied' as const }))
  const registry = new AgentToolRegistry(authorize), execute = vi.fn(async () => ({ ok: true, content: 'original' }))
  registry.register({ definition: { name: 'read' }, execute })
  const afterTool = vi.fn(async () => ({ ok: true, content: 'changed' }))
  expect(await registry.execute('read', { path: 'allowed' }, { beforeTool: async () => ({ path: 'denied' }), afterTool })).toMatchObject({ ok: false })
  expect(authorize).toHaveBeenLastCalledWith('read', { path: 'denied' }, expect.anything())
  expect(execute).not.toHaveBeenCalled(); expect(afterTool).not.toHaveBeenCalled()
  expect(await registry.execute('read', { path: 'denied' }, { beforeTool: async () => ({ path: 'allowed' }), afterTool })).toEqual({ ok: true, content: 'changed' })
})
it('applies input and per-request context hooks without changing persisted model history', async () => {
  const requests: any[] = []
  const client: ModelClient = { provider: 'fixture', requestStyle: 'custom-runtime',
    capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
    create: async request => { requests.push(structuredClone(request.messages)); return { content: 'answer', finishReason: 'stop' } },
    async *stream() { throw new Error('Unexpected stream') },
  }
  const input = [{ role: 'user' as const, content: 'original' }]
  const result = await new AgentRuntime({ tools: new AgentToolRegistry(), skillsEnabled: false }).run({ messages: input, modelClient: client, memoryEnabled: false,
    toolContext: {
      transformInput: async () => [{ role: 'user', content: 'transformed' }],
      transformContext: async messages => [...messages, { role: 'system', content: 'ephemeral' }],
    },
  })
  expect(requests[0]).toContainEqual({ role: 'user', content: 'transformed' })
  expect(requests[0].at(-1)).toEqual({ role: 'system', content: 'ephemeral' })
  expect(result.messages.some(message => message.content === 'ephemeral')).toBe(false)
  expect(input[0].content).toBe('original')
})
