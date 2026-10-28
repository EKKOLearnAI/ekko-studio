import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Explicit opt-in: uses the configured provider, with a disposable memory database.
it.skipIf(process.env.PERSON_MEMORY_LIVE !== '1')('remembers, recalls, corrects and forgets a name with the real configured model', async () => {
  await import('../../packages/server/src/bootstrap/authorized-provider-adapter')
  await import('../../packages/server/src/bootstrap/agent-profile-adapter')
  const { resolveEkkoProviderRuntimeConfig, createEkkoAuthorizedProviderFetch } = await import('../../packages/server/src/modules/ekko/services/provider-runtime')
  const { createModelClient, resolveModelProviderConfigs, MemoryService, SqliteMemoryStore, EkkoDatabaseManager } = await import('../../packages/ekko-agent/src')
  const { createPersonAgent } = await import('../../packages/server/src/bootstrap/person-chat-agent')
  const { PERSON_SYSTEM_PROMPT } = await import('../../packages/server/src/modules/studio/services/person/model')
  const selection = { runtime: 'ekko', mode: 'scoped' as const, profile: 'default', provider: 'deepseek', model: 'deepseek-flash' }
  const config = await resolveEkkoProviderRuntimeConfig(selection)
  const { providerConfig } = resolveModelProviderConfigs({ ...config, provider: selection.provider, model: selection.model })
  const client = createModelClient(providerConfig, { fetch: createEkkoAuthorizedProviderFetch({ ...selection, accessToken: config.apiKey }) })
  const dir = mkdtempSync(join(tmpdir(), 'person-memory-live-'))
  const service = new MemoryService({ store: new SqliteMemoryStore(new EkkoDatabaseManager({ databasePath: join(dir, 'memory.db') })), automaticRecallTokenBudget: 1000 })
  const identity = { sessionId: 'person-main-fixture', profileId: 'person:fixture', recallScopes: [{ type: 'profile' as const }], writeScopes: [{ type: 'profile' as const }], defaultWriteScope: { type: 'profile' as const } }
  const turns: any[] = []
  async function turn(text: string) {
    const agent = createPersonAgent({ selection, memory: { service, identity }, tools: [], systemPrompt: PERSON_SYSTEM_PROMPT,
      workspace: dir, contextTokens: 16000, maxSteps: 6 })
    const events: any[] = []
    const result = await agent.run({ modelClient: client, messages: [{ role: 'user', content: text }],
      memoryInput: { messages: [{ role: 'user', content: text }] }, reasoningEffort: 'none', signal: AbortSignal.timeout(90000),
      onEvent: event => { if (event.type === 'tool.completed' || event.type === 'model.completed') events.push(event) } })
    await service.drain()
    const nodes = await service.list({ profileId: identity.profileId })
    turns.push({ input: text, output: result.output.content, nodes, events, usage: result.output.usage, context: result.contextEstimate })
    return { text: result.output.content, nodes }
  }
  try {
    const saved = await turn('请记住，我的名字是 ekko。')
    expect(saved.nodes.some(n => n.key === 'profile.identity.name' && JSON.stringify(n.valueJson).toLowerCase().includes('ekko'))).toBe(true)
    expect((await turn('你知道我叫啥吗')).text.toLowerCase()).toContain('ekko')
    expect((await turn('你找不到记忆吗？告诉我怎么称呼我。')).text.toLowerCase()).toContain('ekko')
    const corrected = await turn('更正记忆，我的名字现在是 nova，不再叫 ekko。')
    expect(corrected.nodes.filter(n => n.key === 'profile.identity.name')).toHaveLength(1)
    expect(JSON.stringify(corrected.nodes.find(n => n.key === 'profile.identity.name')!.valueJson).toLowerCase()).toContain('nova')
    const recalled = await turn('我的名字是什么？')
    expect(recalled.text.toLowerCase()).toContain('nova')
    expect(recalled.text.toLowerCase()).not.toContain('ekko')
    expect((await turn('忘掉我的名字。')).nodes.filter(n => n.key === 'profile.identity.name')).toEqual([])
    const forgotten = await turn('你知道我的名字吗？')
    expect(forgotten.text.toLowerCase()).not.toMatch(/ekko|nova/)
  } finally {
    writeFileSync('/tmp/person-memory-live-result.json', JSON.stringify({ model: selection.model, turns }, null, 2))
    await service.drain(); service.close(); rmSync(dir, { recursive: true, force: true })
  }
}, 240000)
