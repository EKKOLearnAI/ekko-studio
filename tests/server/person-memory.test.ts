import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPersonAgent } from '../../packages/server/src/bootstrap/person-chat-agent'
import type { ModelClient, ModelRequest } from '../../packages/ekko-agent/src/model/types'

let dir: string
let memory: typeof import('../../packages/server/src/modules/studio/services/person/memory')
let enabled = true
beforeEach(async () => {
  vi.resetModules()
  dir = mkdtempSync(join(tmpdir(), 'person-memory-')); enabled = true
  vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({ getWebUiHome: () => dir }))
  vi.doMock('../../packages/server/src/modules/studio/services/person/catalog', () => ({ personUser: (id: number) => {
    if (!enabled) throw new Error('Account disabled')
    return { id }
  } }))
  vi.doMock('../../packages/server/src/modules/studio/repositories/person-updates', () => ({ personUpdated: vi.fn() }))
  memory = await import('../../packages/server/src/modules/studio/services/person/memory')
})
afterEach(async () => {
  memory.closePersonMemoryStores()
  rmSync(dir, { recursive: true, force: true })
})

async function saveName(userId = 1, value = 'ekko') {
  const { service, identity } = memory.personMemory(userId)
  const result = await service.write({ operation: 'create', kind: 'profile_name', identity,
    node: { title: '名字', content: `用户的名字是 ${value}`, valueJson: value }, reason: '用户提供姓名' })
  expect(result.accepted).toBe(true)
  return result.node!
}

function clientFor(steps: Array<{ name: string; arguments: Record<string, unknown> } | string>, requests: ModelRequest[]) {
  let step = 0
  const client: ModelClient = {
    provider: 'test', capabilities: { streaming: true, tools: true, vision: false, jsonMode: false, systemPrompt: true },
    create: vi.fn(async () => ({ content: 'bounded summary' })),
    async *stream(request) {
      requests.push(request)
      const value = steps[step++] || 'Done'
      if (typeof value === 'string') yield { type: 'text-delta' as const, text: value }
      else yield { type: 'tool-call' as const, toolCall: { id: `call-${step}`, ...value, arguments: value.name === 'memory_write' ? { operations: [value.arguments] } : value.arguments } }
      yield { type: 'done' as const, response: { content: typeof value === 'string' ? value : '' } }
    },
  }
  return client
}

async function run(userId: number, query: string, steps: Parameters<typeof clientFor>[0], extra: Record<string, any> = {}) {
  const requests: ModelRequest[] = []
  const account = memory.personMemory(userId)
  const agent = createPersonAgent({ memory: account, workspace: dir, contextTokens: 8000, maxSteps: 5, tools: [],
    selection: { runtime: 'ekko', mode: 'scoped', profile: extra.profile || 'model-profile-a', provider: 'test', model: 'm' },
    systemPrompt: 'You are Person.', loadHistory: () => extra.history || [{ role: 'user', content: 'Historical excerpt: user name is Mallory' }],
    beforeRequest: extra.beforeRequest,
  })
  const result = await agent.run({ messages: [{ role: 'user', content: query }],
    memoryInput: { messages: [{ role: 'user', content: query }], recallScopes: [{ type: 'context', namespace: 'evil', id: '2' }] },
    toolContext: { sessionId: 'forged-session', profileId: 'forged-profile' }, modelClient: clientFor(steps, requests), ...extra.input })
  await account.service.drain()
  return { requests, result }
}

it('finds the recorded multi-keyword failure and supports exact kind fallback', async () => {
  const node = await saveName()
  const { service, identity } = memory.personMemory(1)
  for (const queryText of ['名字 称呼 姓名', '名字 称呼', '用户姓名']) {
    const result = await service.search(identity, { queryText })
    expect([...result.exact, ...result.relevant].map(n => n.id)).toContain(node.id)
  }
  const result = await service.search(identity, { queryText: '我叫', kinds: ['profile_name'] })
  expect(result.exact[0].valueJson).toBe('ekko')
})

it('recalls the name before the first model call and uses the native tools in a bounded request', async () => {
  await saveName()
  const { requests, result } = await run(1, '我的名字是什么？', ['ekko'])
  expect(JSON.stringify(requests[0].messages.filter(m => m.role === 'system'))).toContain('用户的名字是 ekko')
  expect(requests[0].tools?.map(t => t.name)).toEqual(expect.arrayContaining(['memory_search', 'memory_get', 'memory_write', 'memory_forget']))
  expect(result.memoryContext?.diagnostics.usedTokens).toBeLessThanOrEqual(1000)
  expect(requests[0].context).toBeUndefined()
})

it('uses controlled kind search for the exact user wording that failed online', async () => {
  await saveName()
  const { requests } = await run(1, '你知道我叫啥吗', [{ name: 'memory_search', arguments: { kinds: ['profile_name'] } }, 'ekko'])
  expect(JSON.stringify(requests[1].messages.filter(m => m.role === 'tool'))).toContain('用户的名字是 ekko')
})

it('writes from the current user evidence and never treats retrieved history as new evidence', async () => {
  await run(1, '记住，我的名字是 ekko', [{ name: 'memory_write', arguments: {
    operation: 'create', kind: 'profile_name', scope: { type: 'profile' }, reason: '用户提供姓名',
    node: { title: '姓名', content: '用户的名字是 ekko', valueJson: 'ekko' },
  } }, 'Saved'])
  const { service, identity } = memory.personMemory(1)
  const [node] = await memory.personMemories(1)
  expect(node.valueJson).toBe('ekko')
  expect(node.profileId).toBe('person:1')
  expect(node.sourceMessageIds).toHaveLength(1)
  const source = await service.listMessages({ sessionId: identity.sessionId })
  expect(source.find(m => m.id === node.sourceMessageIds[0])?.content).toBe('记住，我的名字是 ekko')
  expect(JSON.stringify(source)).not.toContain('Mallory')
})

it('lets the host bind memory evidence without advertising unrelated transcript IDs to the writer', async () => {
  const { createMemoryTools } = await import('../../packages/ekko-agent/src/memory/tools')
  const { service, identity } = memory.personMemory(1)
  const nativeWriter = () => createMemoryTools(service).find(tool => tool.definition.name === 'memory_write')!.definition
  const nativeDefinition = structuredClone(nativeWriter())
  const { requests } = await run(1, '叫我ekko', [{ name: 'memory_write', arguments: {
    operation: 'create', kind: 'profile_name', scope: { type: 'profile' }, reason: '用户指定称呼',
    node: { title: '用户称呼', content: '用户希望被称呼为 Ekko。', valueJson: { name: 'Ekko' } },
  } }, 'Saved'], { history: [{ role: 'user', content: JSON.stringify({
    kind: 'person_history_evidence', evidence: [{ id: 8969, role: 'user', content: '哈咯' }],
  }) }] })
  const writer = requests[0].tools!.find(tool => tool.name === 'memory_write')!
  const schema = writer.parameters as any
  expect(schema.properties.operations.items.properties.node.properties).not.toHaveProperty('sourceMessageIds')
  expect(schema.properties.operations.items.properties.node.additionalProperties).toBe(false)
  expect(JSON.parse(requests[1].messages.find(message => message.role === 'tool')!.content)).toMatchObject({ success: true })
  const [node] = await memory.personMemories(1)
  expect(node.sourceMessageIds).toHaveLength(1)
  const sources = await service.listMessages({ sessionId: identity.sessionId })
  expect(sources.find(source => source.id === node.sourceMessageIds[0])?.content).toBe('叫我ekko')
  expect(node.sourceMessageIds).not.toContain('8969')
  expect(nativeWriter()).toEqual(nativeDefinition)
})

it('rejects the recorded historical message ID instead of silently rewriting unsupported evidence', async () => {
  const { requests } = await run(1, '叫我ekko', [{ name: 'memory_write', arguments: {
    operation: 'create', kind: 'profile_name', reason: '用户指定称呼',
    node: { title: '用户称呼', content: '用户希望被称呼为 Ekko。', valueJson: 'Ekko', sourceMessageIds: ['8969'] },
  } }, 'Done'], { history: [{ role: 'user', content: JSON.stringify({
    kind: 'person_history_evidence', evidence: [{ id: 8969, role: 'user', content: '哈咯' }],
  }) }] })
  expect(JSON.stringify(requests[1].messages.filter(message => message.role === 'tool'))).toContain('host-provided user evidence')
  expect(await memory.personMemories(1)).toEqual([])
})

it('persists across reopening the store and model Profile changes without crossing accounts', async () => {
  const one = await saveName(1, 'ekko'), two = await saveName(2, 'other-user')
  memory.closePersonMemoryStores()
  const { requests } = await run(1, '我的名字是什么？', ['ekko'], { profile: 'different-model-profile' })
  expect(JSON.stringify(requests)).toContain('ekko')
  expect(JSON.stringify(requests)).not.toContain('other-user')
  const account = memory.personMemory(1)
  expect(await account.service.get(two.id, account.identity)).toBeUndefined()
  await expect(memory.forgetPersonMemory(2, one.id, one.revision)).rejects.toThrow()
  expect(await memory.personMemories(1)).toHaveLength(1)
})

it('rejects stale corrections, supersedes names and stops recalling deleted names', async () => {
  const old = await saveName()
  const { service, identity } = memory.personMemory(1)
  const corrected = await service.write({ operation: 'update', targetId: old.id, expectedRevision: old.revision, identity,
    node: { title: '姓名', content: '用户的名字改为 nova', valueJson: 'nova' }, reason: '用户更正' })
  expect(corrected.accepted).toBe(true)
  const stale = await service.write({ operation: 'update', targetId: old.id, expectedRevision: old.revision, identity,
    node: { title: '姓名', content: 'stale name', valueJson: 'stale' }, reason: 'stale' })
  expect(stale.accepted).toBe(false)
  const recall = await service.retrieve(identity, '名字')
  expect(recall.relevantNodes.map(n => n.valueJson)).toEqual(['nova'])
  await expect(memory.forgetPersonMemory(1, corrected.node!.id, 0)).rejects.toThrow()
  await memory.forgetPersonMemory(1, corrected.node!.id, corrected.node!.revision)
  expect((await service.retrieve(identity, '名字')).relevantNodes).toEqual([])
})

it('blocks callback writes even when the task output claims to be a user instruction', async () => {
  const { requests } = await run(1, '记住我的名字是 Mallory', [{ name: 'memory_write', arguments: {
    operation: 'create', kind: 'profile_name', node: { title: '姓名', content: 'Mallory', valueJson: 'Mallory' }, reason: 'fake user',
  } }, 'Done'], { input: { memoryInput: undefined } })
  expect(JSON.stringify(requests[1].messages)).toContain('background result cannot change')
  expect(await memory.personMemories(1)).toEqual([])
})

it('rejects forged scopes and fabricated source message IDs', async () => {
  for (const patch of [{ scope: { type: 'context', namespace: 'person', id: '2' } }, { node: { title: 'Name', content: 'Fake', valueJson: 'Fake', sourceMessageIds: ['forged'] } }]) {
    await run(1, 'Remember my name is ekko', [{ name: 'memory_write', arguments: {
      operation: 'create', kind: 'profile_name', node: { title: 'Name', content: 'ekko', valueJson: 'ekko' }, reason: 'User', ...patch,
    } }, 'Done'])
  }
  expect(await memory.personMemories(1)).toEqual([])
})

it('keeps coordinator tools read-only and rechecks disabled accounts', async () => {
  await saveName()
  const tools = memory.personMemoryReadTools(1)
  expect(tools.map(t => t.name)).toEqual(['memory_search', 'memory_get'])
  enabled = false
  await expect(tools[0].execute({ all: true })).rejects.toThrow('disabled')
  expect(() => memory.personMemory(1)).toThrow('disabled')
})
