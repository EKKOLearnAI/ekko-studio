import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentRuntime,
  EkkoDatabaseManager,
  MemoryService,
  SqliteMemoryStore,
  createMemoryTools,
  hasExplicitMemoryForgetIntent,
  resolveMemoryQuery,
  type MemoryNode,
  type MemoryStore,
  type ModelClient,
  type ModelRequest,
} from '../../packages/ekko-agent/src'

let webUiHome = ''
let store: SqliteMemoryStore
let service: MemoryService

beforeEach(async () => {
  webUiHome = await mkdtemp(join(tmpdir(), 'ekko-memory-service-'))
  store = new SqliteMemoryStore(new EkkoDatabaseManager({ baseDirectory: webUiHome }))
  service = new MemoryService({ store })
})

afterEach(async () => {
  service.close()
  await rm(webUiHome, { recursive: true, force: true })
})

describe('MemoryService', () => {
  it('does not treat negated configuration deletion text as a memory-forget request', () => {
    expect(hasExplicitMemoryForgetIntent([{
      role: 'user',
      content: '不要删除用户配置、认证信息，也不要忘记现有偏好。',
    }])).toBe(false)
    expect(hasExplicitMemoryForgetIntent([{
      role: 'user',
      content: '请删除你保存的这条记忆。',
    }])).toBe(true)
  })

  it('does not retain a memory approval queue table', () => {
    const row = store.databaseManager.connection.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_review_jobs'",
    ).get()
    expect(row).toBeUndefined()
  })

  it('keeps identical canonical keys independent across profile, context, and session scopes', async () => {
    const contextA = { type: 'context' as const, namespace: 'test.chat', id: 'conversation-a' }
    const contextB = { type: 'context' as const, namespace: 'test.chat', id: 'conversation-b' }
    const profile = { type: 'profile' as const }
    const session = { type: 'session' as const, id: 'runtime-a' }
    const createLocation = async (scope: typeof profile | typeof contextA | typeof contextB | typeof session, value: string) => service.write({
      operation: 'create',
      kind: 'home_location',
      scope,
      reason: `Store ${value} in its declared scope.`,
      explicitUserIntent: true,
      identity: {
        sessionId: 'runtime-a',
        profileId: 'default',
        recallScopes: [profile, contextA, contextB, session],
        writeScopes: [profile, contextA, contextB, session],
        defaultWriteScope: scope,
        origin: { host: 'test-host', namespace: 'chat', contextId: scope.type === 'context' ? scope.id : 'runtime-a' },
      },
      node: { valueJson: value, title: `常住地：${value}`, content: `用户常住在${value}。` },
    })

    const profileNode = await createLocation(profile, '上海')
    const contextANode = await createLocation(contextA, '北京')
    const contextBNode = await createLocation(contextB, '广州')
    const sessionNode = await createLocation(session, '杭州')

    expect([profileNode, contextANode, contextBNode, sessionNode])
      .toEqual(expect.arrayContaining([expect.objectContaining({ accepted: true, action: 'created' })]))
    await expect(service.list({ profileId: 'default', key: 'profile.location.home' }))
      .resolves.toHaveLength(4)

    const currentConversation = await service.search({
      sessionId: 'runtime-a',
      profileId: 'default',
      recallScopes: [profile, contextA, session],
    }, { kinds: ['home_location'], limit: 10 })
    expect(currentConversation.exact.map(node => node.valueJson)).toEqual(expect.arrayContaining(['上海', '北京', '杭州']))
    expect(currentConversation.exact.map(node => node.valueJson)).not.toContain('广州')

    const legacyCaller = await service.search(
      { sessionId: 'legacy-runtime', profileId: 'default' },
      { kinds: ['home_location'], limit: 10 },
    )
    expect(legacyCaller.exact.map(node => node.valueJson)).toEqual(['上海'])
    await expect(service.get(contextANode.nodeId!, {
      sessionId: 'legacy-runtime',
      profileId: 'default',
    })).resolves.toBeUndefined()
    await expect(service.get(contextANode.nodeId!, { profileId: 'default' }))
      .resolves.toMatchObject({ valueJson: '北京', scope: contextA })
    expect(contextANode.node).toMatchObject({
      scope: contextA,
      origin: { host: 'test-host', namespace: 'chat', contextId: 'conversation-a' },
    })
  })

  it('migrates version-3 nodes to profile scope without deleting them', async () => {
    const manager = new EkkoDatabaseManager({ databasePath: join(webUiHome, 'legacy-memory.db') })
    manager.connection.exec(`
      CREATE TABLE memory_nodes (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        parent_id TEXT,
        supersedes_id TEXT,
        profile_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        category_path_json TEXT NOT NULL,
        category_path_text TEXT NOT NULL,
        type TEXT NOT NULL,
        key TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        value_json TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        importance REAL NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        entities_json TEXT NOT NULL DEFAULT '[]',
        source_message_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE UNIQUE INDEX idx_memory_nodes_unique_active_key
        ON memory_nodes (profile_id, key) WHERE status = 'active';
    `)
    manager.connection.prepare(
      'INSERT INTO schema_migrations (component, version, applied_at) VALUES (?, ?, ?)',
    ).run('memory', 3, '2026-01-01T00:00:00.000Z')
    manager.connection.prepare(`
      INSERT INTO memory_nodes (
        id, profile_id, domain, category_path_json, category_path_text, type, key,
        revision, value_json, title, content, status, confidence, importance,
        tags_json, entities_json, source_message_ids_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-node', 'default', 'profile', '["location"]', 'location', 'fact',
      'profile.location.home', 1, '"\u82cf\u5dde"', '常住地', '用户常住苏州。', 'active', 0.9, 0.8,
      '[]', '["\u82cf\u5dde"]', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
    )

    const migrated = new SqliteMemoryStore(manager)
    try {
      await expect(migrated.getNode('legacy-node')).resolves.toMatchObject({
        id: 'legacy-node',
        scope: { type: 'profile' },
        valueJson: '苏州',
      })
      expect(manager.connection.prepare(
        'SELECT 1 AS applied FROM schema_migrations WHERE component = ? AND version = ?',
      ).get('memory', 4)).toMatchObject({ applied: 1 })
    } finally {
      migrated.close()
    }
  })

  it('exposes standalone CRUD, history, and audit methods', async () => {
    const identity = { sessionId: 'memory-api', profileId: 'default' }
    const messageIds = await service.captureMessages(identity, [
      { role: 'user', content: 'I prefer a dark interface.' },
      { role: 'assistant', content: 'I will remember that.' },
    ])

    const created = await service.create({
      kind: 'general_preference',
      itemKey: 'interface_theme',
      reason: 'Explicit user preference.',
      explicitUserIntent: true,
      identity,
      node: {
        valueJson: 'dark',
        title: 'Interface theme',
        content: 'The user prefers a dark interface.',
        sourceMessageIds: [messageIds[0]],
      },
    })
    expect(created).toMatchObject({ accepted: true, action: 'created' })

    const active = await service.list({ profileId: 'default' })
    expect(active).toMatchObject([{ id: created.nodeId, status: 'active', revision: 1 }])
    await expect(service.get(created.nodeId!, identity)).resolves.toMatchObject({ valueJson: 'dark' })

    const updated = await service.update(created.nodeId!, {
      reason: 'The user changed the preference.',
      expectedRevision: created.node!.revision,
      explicitUserIntent: true,
      identity,
      node: {
        valueJson: 'light',
        title: 'Interface theme',
        content: 'The user prefers a light interface.',
      },
    })
    expect(updated).toMatchObject({ accepted: true, action: 'updated', node: { revision: 2, valueJson: 'light' } })
    await expect(service.list({
      profileId: 'default',
      statuses: ['superseded'],
    })).resolves.toMatchObject([{ id: created.nodeId, status: 'superseded' }])

    const messages = await service.listMessages({ sessionId: identity.sessionId, limit: 10 })
    expect(messages.map(message => message.id)).toEqual(messageIds)
    const removed = await service.delete(updated.nodeId!, {
      reason: 'The user asked Ekko to forget this preference.',
      expectedRevision: updated.node!.revision,
      identity,
    })
    expect(removed).toMatchObject({ mode: 'soft', deletedIds: [updated.nodeId] })
    await expect(service.list({
      profileId: 'default',
      statuses: ['deleted'],
    })).resolves.toMatchObject([{ id: updated.nodeId, status: 'deleted', revision: 3 }])

    const audits = await service.listAuditEvents({
      profileId: 'default',
      sessionId: identity.sessionId,
    })
    expect(audits.map(event => event.eventType)).toEqual(['delete', 'supersede', 'create'])
    expect(audits.every(event => event.profileId === 'default')).toBe(true)
  })

  it('hard-deletes directly through the exported delete method', async () => {
    const identity = { sessionId: 'memory-hard-delete', profileId: 'default' }
    const created = await service.create({
      kind: 'general_preference',
      itemKey: 'temporary_note',
      reason: 'Store a temporary fact.',
      explicitUserIntent: true,
      identity,
      node: {
        valueJson: 'temporary',
        title: 'Temporary note',
        content: 'A temporary note.',
      },
    })
    expect(created).toMatchObject({ accepted: true, action: 'created' })

    await expect(service.delete(created.nodeId!, {
      mode: 'hard',
      reason: 'Remove the temporary fact.',
      expectedRevision: created.node!.revision,
      identity,
    })).resolves.toMatchObject({ mode: 'hard', deletedIds: [created.nodeId] })
    await expect(service.get(created.nodeId!, identity)).resolves.toBeUndefined()
  })


  it('keeps the latest 20 messages in automatic memory context by default', async () => {
    const identity = { sessionId: 's1', profileId: 'default' }
    await service.captureMessages(identity, Array.from({ length: 25 }, (_, index) => ({
      role: 'user' as const,
      content: `message-${index + 1}`,
    })))

    const context = await service.retrieve(identity)

    expect(context.recentMessages).toHaveLength(20)
    expect(context.recentMessages[0]?.content).toBe('message-6')
    expect(context.recentMessages.at(-1)?.content).toBe('message-25')
  })

  it('generates canonical keys on the server and stores one profile memory shape', async () => {
    const accepted = await service.write({
      operation: 'create',
      kind: 'food_avoidance',
      itemKey: 'tofu',
      reason: 'explicit',
      explicitUserIntent: true,
      identity: { sessionId: 's1', profileId: 'work' },
      node: userPreference('tofu'),
    })
    expect(accepted).toMatchObject({
      accepted: true,
      action: 'created',
      node: { key: 'preference.food.avoid:tofu', revision: 1 },
    })
    const exact = await service.search(
      { sessionId: 's1', profileId: 'work' },
      { domain: 'preference', key: 'preference.food.avoid:tofu', valueJson: 'tofu' },
    )
    expect(exact.exact).toMatchObject([{ profileId: 'work', valueJson: 'tofu' }])
  })

  it('searches controlled memory kinds without relying on natural-language matching', async () => {
    const identity = { sessionId: 's1', profileId: 'default' }
    await service.write({
      operation: 'create',
      kind: 'general_preference',
      itemKey: 'visual_theme',
      reason: '用户陈述稳定偏好。',
      identity,
      node: {
        valueJson: '深色界面',
        title: '界面主题偏好',
        content: '用户偏好使用深色界面。',
      },
    })
    await service.write({
      operation: 'create',
      kind: 'habit_routine',
      itemKey: 'weekly_review',
      reason: '用户陈述固定习惯。',
      identity,
      node: {
        valueJson: '每周复盘',
        title: '复盘习惯',
        content: '用户保持每周复盘的习惯。',
      },
    })
    await service.write({
      operation: 'create',
      kind: 'home_location',
      reason: '用户陈述常住地。',
      identity,
      node: { valueJson: '测试城市', title: '用户常住地', content: '用户常住在测试城市。' },
    })

    const tool = createMemoryTools(service).find(item => item.definition.name === 'memory_search')!
    const result = await tool.execute({
      kinds: ['general_preference', 'habit_routine'],
      limit: 10,
    }, identity)

    expect(result.ok).toBe(true)
    expect((result.data as { exact: MemoryNode[] }).exact.map(node => node.key).sort()).toEqual([
      'preference.general:visual_theme',
      'profile.habit:weekly_review',
    ])
  })

  it('prefers corrections when resolving unified-memory conflicts', () => {
    const nodes = [
      memoryNode('older'),
      memoryNode('newer', { updatedAt: '2026-01-02T00:00:00.000Z' }),
      memoryNode('correction', { type: 'correction' }),
    ]
    const result = resolveMemoryQuery([], nodes, undefined, 10)
    expect(result.relevant.map(node => node.id)).toEqual(['correction'])
    expect(result.omitted).toEqual(expect.arrayContaining([
      { nodeId: 'older', reason: 'conflict_lost' },
      { nodeId: 'newer', reason: 'conflict_lost' },
    ]))
  })

  it('uses a 4000-token budget instead of a fixed automatic card count', async () => {
    for (let index = 0; index < 60; index += 1) {
      await store.upsertNode(memoryNode(`budget-${index}`, {
        type: 'constraint',
        key: `constraint.hard:budget_${index}`,
        title: `Budget preference ${index}`,
        content: `Preference ${index}: ${'compact detail '.repeat(80)}`,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      }))
    }

    const context = await service.retrieve(
      { sessionId: 's1', profileId: 'default' },
      'unrelated current request',
    )

    expect(context.relevantNodes.length).toBeGreaterThan(12)
    expect(context.relevantNodes.length).toBeLessThan(60)
    expect(context.diagnostics).toMatchObject({
      tokenBudget: 4000,
      retrievedNodeCount: context.relevantNodes.length,
    })
    expect(context.diagnostics.usedTokens).toBeLessThanOrEqual(4000)
    expect(context.diagnostics.omittedNodeCount).toBe(60 - context.relevantNodes.length)
  })

  it('finds relevant old facts outside the former importance-based candidate window', async () => {
    await store.upsertNode(memoryNode('needle', {
      type: 'fact',
      key: 'custom.fact:needle',
      title: 'Archived deployment codename',
      content: 'The archived deployment codename is needle-orchid.',
      importance: 0.01,
      confidence: 0.4,
      updatedAt: '2020-01-01T00:00:00.000Z',
    }))
    for (let index = 0; index < 180; index += 1) {
      await store.upsertNode(memoryNode(`noise-${index}`, {
        type: 'fact',
        key: `custom.fact:noise_${index}`,
        title: `Recent unrelated fact ${index}`,
        content: `Recent unrelated content ${index}`,
        importance: 1,
        confidence: 1,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      }))
    }

    const context = await service.retrieve(
      { sessionId: 's1', profileId: 'default' },
      'needle-orchid',
    )

    expect(context.relevantNodes.map(node => node.id)).toContain('needle')
  })

  it('recalls ordinary preferences only when they match the current request', async () => {
    await service.write({
      operation: 'create',
      kind: 'general_preference',
      itemKey: 'interface_theme',
      reason: 'explicit',
      explicitUserIntent: true,
      identity: { sessionId: 's1', profileId: 'default' },
      node: {
        valueJson: 'dark interface',
        title: 'Interface theme',
        content: 'The user prefers a dark interface.',
      },
    })

    const unrelated = await service.retrieve(
      { sessionId: 's1', profileId: 'default' },
      'Plan a weekend trip',
    )
    const related = await service.retrieve(
      { sessionId: 's1', profileId: 'default' },
      'Configure the dark interface',
    )

    expect(unrelated.relevantNodes).toHaveLength(0)
    expect(related.relevantNodes.map(node => node.key)).toContain('preference.general:interface_theme')
  })

  it('defaults and clamps direct memory searches to 50 results at runtime', async () => {
    for (let index = 0; index < 60; index += 1) {
      await store.upsertNode(memoryNode(`search-${index}`, {
        key: `preference.general:search_${index}`,
      }))
    }

    const identity = { sessionId: 's1', profileId: 'default' }
    const defaultResult = await service.search(identity, {})
    const result = await service.search(identity, { limit: 999 })

    expect([...defaultResult.exact, ...defaultResult.relevant]).toHaveLength(50)
    expect([...result.exact, ...result.relevant]).toHaveLength(50)
  })

  it('keeps independent multi-value preferences and isolates profiles', async () => {
    for (const value of ['香菜', '芹菜']) {
      await service.write({
        operation: 'create',
        kind: 'food_avoidance',
        itemKey: value,
        reason: 'explicit',
        explicitUserIntent: true,
        identity: { sessionId: 's1', profileId: 'work' },
        node: userPreference(value),
      })
    }
    const result = await service.search({ sessionId: 's1', profileId: 'work' }, { domain: 'preference', limit: 10 })
    const nodes = [...result.exact, ...result.relevant]
    expect(nodes.map(node => node.valueJson).sort()).toEqual(['芹菜', '香菜'])
    await expect(service.get(nodes[0].id, { sessionId: 'other', profileId: 'personal' })).resolves.toBeUndefined()
    await expect(service.forget({
      id: nodes[0].id,
      reason: 'cross-profile attempt',
      identity: { sessionId: 'other', profileId: 'personal' },
    })).resolves.toMatchObject({ deletedIds: [], reason: 'No matching memory was found.' })

    await expect(service.write({
      operation: 'create',
      kind: 'food_avoidance',
      itemKey: '葱',
      reason: 'cross-profile attempt',
      explicitUserIntent: true,
      identity: { sessionId: 's1', profileId: 'work' },
      node: { ...userPreference('葱'), profileId: 'personal' },
    })).resolves.toMatchObject({
      accepted: false,
      reason: 'Memory profileId does not match the runtime identity.',
    })
  })

  it('injects retrieved memory and direct memory tools into foreground runtime requests', async () => {
    await service.write({
      operation: 'create',
      kind: 'food_avoidance',
      itemKey: '香菜',
      reason: 'explicit',
      explicitUserIntent: true,
      identity: { sessionId: 's1', profileId: 'default' },
      node: userPreference('香菜'),
    })
    const client = modelClient()
    const runtime = new AgentRuntime({ modelClient: client, memory: service })
    const result = await runtime.run({
      messages: ['推荐一道菜'],
      contextKey: 's1',
      toolContext: { sessionId: 's1', profileId: 'default' },
    })

    const request = vi.mocked(client.create).mock.calls[0][0] as ModelRequest
    expect(request.messages[0].content).toContain('## Memory Usage Rules')
    expect(request.messages[0].content).toContain('about to answer that you do not know or remember')
    expect(request.messages[0].content).toContain('Memory mutations happen immediately')
    expect(request.messages[0].content).toContain('Avoid 香菜')
    expect(request.messages[0].content).toContain('key=preference.food.avoid:香菜 revision=1')
    expect(request.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'memory_search', 'memory_get', 'memory_write', 'memory_forget',
    ]))
    expect(request.tools?.map(tool => tool.name)).not.toContain('memory_review')
    expect(result.memoryContext?.usedMemoryIds).toHaveLength(1)
  })

  it('writes explicit memory directly without forcing or narrowing the foreground request', async () => {
    let foregroundCalls = 0
    const create = vi.fn(async (request: ModelRequest) => {
      foregroundCalls += 1
      return foregroundCalls === 1
        ? {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'foreground-memory-write',
              name: 'memory_write',
              arguments: {
                operation: 'create',
                kind: 'home_location',
                explicitUserIntent: true,
                reason: '用户明确说明当前常住地。',
                node: { valueJson: '贵阳', title: '用户常住地', content: '用户当前常住在贵阳。' },
              },
            }],
          }
        : { content: '已经记住。', finishReason: 'stop' }
    })
    const client: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
      create,
      stream: vi.fn(),
    }
    const runtime = new AgentRuntime({ modelClient: client, memory: service })

    const runResult = await runtime.run({
      messages: ['请记住我现在常住贵阳'],
      contextKey: 'foreground-source-session',
      toolContext: { sessionId: 'foreground-source-session', profileId: 'default' },
    })
    const foregroundRequest = create.mock.calls[0][0] as ModelRequest
    expect(foregroundRequest.toolChoice).toBeUndefined()
    expect(foregroundRequest.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'read_file',
      'memory_search', 'memory_get', 'memory_write', 'memory_forget',
    ]))
    expect(runResult.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool',
        toolName: 'memory_write',
        result: expect.objectContaining({
          ok: true,
          data: expect.objectContaining({ accepted: true, nodeId: expect.any(String) }),
        }),
      }),
    ]))
    await service.drain()

    const result = await service.search(
      { sessionId: 'foreground-source-session', profileId: 'default' },
      { key: 'profile.location.home' },
    )
    expect(result.exact).toMatchObject([{
      valueJson: '贵阳',
      sourceMessageIds: [expect.any(String)],
    }])
    const sourceId = result.exact[0].sourceMessageIds[0]
    await expect(store.listMessagesAfter({ sessionId: 'foreground-source-session', limit: 10 }))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({
        id: sourceId,
        role: 'user',
        content: '请记住我现在常住贵阳',
      })]))
    expect(create.mock.calls.some(call => (call[0] as ModelRequest).metadata?.purpose === 'ekko-memory-review'))
      .toBe(false)
  })

  it('recognizes 清掉你所有的记忆 without forcing or narrowing the foreground request', async () => {
    const identity = { sessionId: 'foreground-forget-all', profileId: 'default' }
    const createdIds: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const created = await service.write({
        operation: 'create',
        kind: 'general_preference',
        itemKey: `forget_all_${index}`,
        reason: 'Set up direct forget-all coverage.',
        explicitUserIntent: true,
        identity,
        node: userPreference(`memory-${index}`),
      })
      createdIds.push(created.nodeId!)
    }

    let foregroundCalls = 0
    const create = vi.fn(async (request: ModelRequest) => {
      foregroundCalls += 1
      return foregroundCalls === 1
        ? {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'foreground-memory-forget-all',
              name: 'memory_forget',
              arguments: {
                all: true,
                mode: 'hard',
                reason: '用户明确要求清除所有记忆',
              },
            }],
          }
        : { content: '已经清除。', finishReason: 'stop' }
    })
    const client: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
      create,
      stream: vi.fn(),
    }
    const runtime = new AgentRuntime({ modelClient: client, memory: service })

    const runResult = await runtime.run({
      messages: ['清掉你所有的记忆'],
      contextKey: identity.sessionId,
      toolContext: identity,
    })
    const foregroundRequest = create.mock.calls[0][0] as ModelRequest
    expect(foregroundRequest.toolChoice).toBeUndefined()
    expect(foregroundRequest.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'read_file',
      'memory_search', 'memory_get', 'memory_write', 'memory_forget',
    ]))
    expect(runResult.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool',
        toolName: 'memory_forget',
        result: expect.objectContaining({
          ok: true,
          data: expect.objectContaining({
            mode: 'hard',
            deletedIds: expect.arrayContaining(createdIds),
          }),
        }),
      }),
    ]))
    await service.drain()
    await expect(service.list({ profileId: 'default' })).resolves.toEqual([])
  })

  it('enumerates all visible memories instead of relevance-searching a list-all phrase', async () => {
    const identity = { sessionId: 'list-all-memories', profileId: 'default' }
    for (let index = 0; index < 5; index += 1) {
      await service.write({
        operation: 'create',
        kind: 'general_preference',
        itemKey: `list_all_${index}`,
        reason: 'Set up complete-store enumeration coverage.',
        explicitUserIntent: true,
        identity,
        node: userPreference(`memory-${index}`),
      })
    }
    const searchTool = createMemoryTools(service).find(tool => tool.definition.name === 'memory_search')!

    const result = await searchTool.execute({ queryText: '所有已存储的记忆', limit: 50 }, identity)

    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ exact: [], relevant: expect.any(Array) })
    expect((result.data as { relevant: MemoryNode[] }).relevant).toHaveLength(5)
  })

  it('keeps running and requests correction after repeated memory mutation failures', async () => {
    const requests: ModelRequest[] = []
    let calls = 0
    const create = vi.fn(async (request: ModelRequest) => {
      requests.push(request)
      calls += 1
      return calls <= 3
        ? {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: `unauthorized-forget-${calls}`,
              name: 'memory_forget',
              arguments: { all: true, mode: 'hard', reason: 'No current-user forget request.' },
            }],
          }
        : { content: '记忆未被清除；我会改用其他方案。', finishReason: 'stop' }
    })
    const client: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
      create,
      stream: vi.fn(),
    }
    const runtime = new AgentRuntime({ modelClient: client, memory: service, maxIdenticalToolFailures: 999 })

    const result = await runtime.run({
      messages: ['你好'],
      contextKey: 'failed-memory-mutation',
      toolContext: { sessionId: 'failed-memory-mutation', profileId: 'default' },
    })

    expect(create).toHaveBeenCalledTimes(4)
    expect(result.output).toMatchObject({
      finishReason: 'stop',
      content: expect.stringContaining('记忆未被清除'),
    })
    expect(requests[3].messages).toContainEqual(expect.objectContaining({
      role: 'system',
      content: expect.stringContaining('Tool recovery required: "memory_forget" failed 3 consecutive times.'),
    }))
  })

  it('deduplicates recaptured messages when unrelated messages shift their positions', async () => {
    const identity = { sessionId: 's1', profileId: 'default' }
    await service.captureMessages(identity, [
      { role: 'user', content: 'same question' },
      { role: 'assistant', content: 'same answer' },
    ])
    await service.captureMessages(identity, [
      { role: 'assistant', content: 'an earlier inserted message' },
      { role: 'user', content: 'same question' },
      { role: 'assistant', content: 'same answer' },
    ])

    await expect(store.listMessagesAfter({ sessionId: 's1', limit: 20 })).resolves.toHaveLength(3)
  })

  it('ignores model-owned taxonomy and returns the full server-owned memory card', async () => {
    const tool = createMemoryTools(service).find(item => item.definition.name === 'memory_write')!
    const result = await tool.execute({
      operation: 'create',
      kind: 'home_location',
      node: {
        valueJson: { city: '厦门', country: '中国' },
        title: '用户常住地',
        content: '用户明确表示常住在中国厦门。',
        type: 'user_preference',
        key: 'model-invented-key',
        summary: '这些字段应被服务端规则覆盖。',
      },
      reason: '用户表明自己常住厦门。',
      explicitUserIntent: true,
    }, {
      sessionId: 's1',
      profileId: 'default',
      sourceMessageIds: ['location-message-1'],
    })

    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({
      action: 'created',
      node: {
        profileId: 'default',
        domain: 'profile',
        type: 'fact',
        key: 'profile.location.home',
        revision: 1,
        valueJson: { city: '厦门', country: '中国' },
        title: '用户常住地',
        content: '用户明确表示常住在中国厦门。',
        entities: ['厦门'],
        sourceMessageIds: ['location-message-1'],
      },
    })
  })

  it('applies mixed memory_write operations atomically and returns a terminal result', async () => {
    const identity = { sessionId: 'atomic-memory-tool', profileId: 'default' }
    const obsolete = await service.write({
      operation: 'create',
      kind: 'general_preference',
      itemKey: 'obsolete_editor',
      node: userPreference('旧编辑器'),
      reason: 'Set up an obsolete memory.',
      explicitUserIntent: true,
      identity,
    })
    const tool = createMemoryTools(service).find(item => item.definition.name === 'memory_write')!

    const result = await tool.execute({
      operations: [
        {
          operation: 'create',
          kind: 'home_location',
          node: { valueJson: '杭州', title: '用户常住地', content: '用户当前常住在杭州。' },
          reason: '用户明确说明当前常住地。',
          explicitUserIntent: true,
        },
        {
          operation: 'delete',
          targetId: obsolete.nodeId,
          expectedRevision: obsolete.node?.revision,
          reason: '用户明确要求删除失效偏好。',
        },
      ],
    }, {
      ...identity,
      memoryExplicitIntent: true,
      memoryForgetIntent: true,
      sourceMessageIds: ['atomic-user-message'],
    })

    expect(result).toMatchObject({
      ok: true,
      data: {
        accepted: true,
        done: true,
        results: [
          { accepted: true, action: 'created' },
          { accepted: true, action: 'deleted', nodeId: obsolete.nodeId },
        ],
      },
    })
    expect(result.content).toContain('do not repeat it')
    await expect(service.get(obsolete.nodeId!, identity)).resolves.toMatchObject({ status: 'deleted' })
    await expect(service.search(identity, { kinds: ['home_location'] })).resolves.toMatchObject({
      exact: [expect.objectContaining({ valueJson: '杭州', sourceMessageIds: ['atomic-user-message'] })],
    })
  })

  it('applies no memory changes when any batch operation fails validation', async () => {
    const identity = { sessionId: 'atomic-validation', profileId: 'default' }
    const result = await service.applyBatch({
      identity,
      explicitUserIntent: true,
      operations: [
        {
          operation: 'create',
          kind: 'language_preference',
          node: { valueJson: '中文', title: '语言偏好', content: '用户偏好中文。' },
          reason: 'Valid first operation.',
        },
        {
          operation: 'create',
          kind: 'project_context',
          node: { valueJson: 'Ekko Studio', title: '项目', content: '用户在维护 Ekko Studio。' },
          reason: 'Missing the required itemKey.',
        },
      ],
    })

    expect(result).toMatchObject({
      accepted: false,
      done: true,
      failedOperationIndex: 1,
      reason: expect.stringContaining('No operations were applied'),
    })
    await expect(service.search(identity, { kinds: ['language_preference'] }))
      .resolves.toMatchObject({ exact: [], relevant: [] })
  })

  it('updates an exact memory by id and revision and rejects stale writes', async () => {
    const identity = { sessionId: 's1', profileId: 'default' }
    const original = await service.write({
      operation: 'create',
      kind: 'home_location',
      explicitUserIntent: true,
      reason: 'The user explicitly asked to remember their location.',
      identity,
      node: { valueJson: '厦门市', title: '用户常住地', content: '用户常住在厦门市。' },
    })
    const tool = createMemoryTools(service).find(item => item.definition.name === 'memory_write')!

    const result = await tool.execute({
      operation: 'update',
      targetId: original.nodeId,
      expectedRevision: original.node?.revision,
      node: {
        valueJson: '广西南宁',
        title: '用户常住地',
        content: '用户明确表示常住在广西南宁。',
        importance: 0.9,
      },
      reason: '用户主动更正所在地为广西南宁。',
    }, identity)

    expect(result.ok).toBe(true)
    await expect(store.getNode(original.nodeId!)).resolves.toMatchObject({ status: 'superseded' })
    await expect(store.getNode((result.data as { nodeId: string }).nodeId)).resolves.toMatchObject({
      profileId: 'default',
      type: 'fact',
      key: 'profile.location.home',
      revision: 2,
      valueJson: '广西南宁',
      content: '用户明确表示常住在广西南宁。',
      entities: ['广西南宁'],
      status: 'active',
    })
    expect(store.databaseManager.connection.prepare(
      "SELECT session_id FROM memory_audit_events WHERE event_type = 'supersede' ORDER BY row_id DESC LIMIT 1",
    ).get()).toMatchObject({ session_id: 's1' })
    await expect(service.write({
      operation: 'update',
      targetId: (result.data as { nodeId: string }).nodeId,
      expectedRevision: 1,
      node: { valueJson: '北京' },
      reason: 'stale write',
      identity,
    })).resolves.toMatchObject({
      accepted: false,
      reason: 'Memory revision mismatch: expected 1, current 2. Search again before mutating.',
    })
  })

  it('keeps one interaction contract and replaces duplicate relationship statements', async () => {
    const identity = { sessionId: 's1', profileId: 'default' }
    await expect(service.write({
      operation: 'create',
      kind: 'interaction_contract',
      explicitUserIntent: true,
      reason: '不允许只写自由文本。',
      identity,
      node: { title: '称呼关系', content: '用户是爸爸，助手是女儿。' },
    })).resolves.toMatchObject({
      accepted: false,
      reason: 'interaction_contract requires structured valueJson with userRole, assistantRole, or addressUserAs.',
    })
    const first = await service.write({
      operation: 'create',
      kind: 'interaction_contract',
      explicitUserIntent: true,
      reason: '用户设定称呼。',
      identity,
      node: {
        valueJson: { userRole: '老爷', addressUserAs: '老爷' },
        title: '用户与助手的互动关系',
        content: '用户希望被称呼为老爷。',
      },
    })
    const second = await service.write({
      operation: 'create',
      kind: 'interaction_contract',
      explicitUserIntent: true,
      reason: '用户更新了双方关系。',
      identity,
      node: {
        valueJson: { userRole: '爸爸', assistantRole: '女儿', addressUserAs: '爸爸' },
        title: '用户与助手的互动关系',
        content: '用户将自己设定为爸爸、助手设定为女儿，并希望被称呼为爸爸。',
      },
    })

    expect(first).toMatchObject({ action: 'created', node: { key: 'interaction.relationship', revision: 1 } })
    expect(second).toMatchObject({ action: 'updated', node: {
      key: 'interaction.relationship',
      revision: 2,
      content: '用户将自己设定为爸爸、助手设定为女儿，并希望被称呼为爸爸。',
      entities: ['爸爸', '女儿'],
    } })
    await expect(store.getNode(first.nodeId!)).resolves.toMatchObject({ status: 'superseded' })
    const active = await store.queryNodes({ profileId: 'default', key: 'interaction.relationship' })
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ id: second.nodeId, revision: 2 })

    const patched = await service.write({
      operation: 'update',
      targetId: second.nodeId,
      expectedRevision: 2,
      valuePatch: { addressUserAs: '父亲' },
      unsetValueFields: ['userRole'],
      node: {
        title: '用户与助手的互动关系',
        content: '助手的互动角色是女儿，并应称呼用户为父亲。',
      },
      reason: '用户只修改称呼并删除自身角色设定。',
      identity,
    })
    expect(patched).toMatchObject({ action: 'updated', node: {
      key: 'interaction.relationship',
      revision: 3,
      valueJson: { assistantRole: '女儿', addressUserAs: '父亲' },
      content: '助手的互动角色是女儿，并应称呼用户为父亲。',
      entities: ['女儿', '父亲'],
    } })
    expect(await store.queryNodes({ profileId: 'default', key: 'interaction.relationship' })).toHaveLength(1)

    await service.write({
      operation: 'create',
      kind: 'home_location',
      explicitUserIntent: true,
      reason: '用户明确说明常住地。',
      identity,
      node: { valueJson: '贵阳', title: '用户常住地', content: '用户常住在贵阳。' },
    })
    const locationSearch = await service.search(identity, {
      queryText: 'home location city 位置 城市',
      limit: 10,
    })
    expect([...locationSearch.exact, ...locationSearch.relevant].map(node => node.key))
      .toEqual(['profile.location.home'])
  })

  it('directly applies broad and hard deletion', async () => {
    for (const value of ['香菜', '芹菜']) {
      await service.write({
        operation: 'create',
        kind: 'food_avoidance',
        itemKey: value,
        reason: 'explicit',
        explicitUserIntent: true,
        identity: { sessionId: 's1', profileId: 'default' },
        node: userPreference(value),
      })
    }
    const one = await service.search({ sessionId: 's1', profileId: 'default' }, { domain: 'preference', limit: 10 })
    const node = [...one.exact, ...one.relevant][0]
    const nodeId = node.id
    await expect(service.forget({
      id: nodeId,
      reason: 'missing revision',
      identity: { sessionId: 's1', profileId: 'default' },
    })).resolves.toMatchObject({
      deletedIds: [],
      reason: 'Mutation requires expectedRevision from memory_search, memory_get, or the injected memory card.',
    })
    await expect(service.forget({
      domain: 'preference',
      reason: 'clear preferences',
      identity: { sessionId: 's1', profileId: 'default' },
    })).resolves.toMatchObject({ deletedIds: expect.arrayContaining([nodeId]), mode: 'soft' })
    await expect(service.search(
      { sessionId: 's1', profileId: 'default' },
      { domain: 'preference', limit: 10 },
    )).resolves.toMatchObject({ exact: [], relevant: [] })

    const hardDelete = await service.write({
      operation: 'create',
      kind: 'general_preference',
      itemKey: 'temporary',
      reason: 'explicit',
      explicitUserIntent: true,
      identity: { sessionId: 's1', profileId: 'default' },
      node: userPreference('temporary'),
    })
    await expect(service.forget({
      id: hardDelete.nodeId,
      expectedRevision: hardDelete.node!.revision,
      mode: 'hard',
      reason: 'erase',
      identity: { sessionId: 's1', profileId: 'default' },
    }))
      .resolves.toMatchObject({ mode: 'hard', deletedIds: [hardDelete.nodeId] })
    await expect(service.get(hardDelete.nodeId!, { profileId: 'default' })).resolves.toBeUndefined()
  })

  it('degrades memory failures without blocking the model response', async () => {
    const failure = async () => { throw new Error('database unavailable') }
    const failingStore = {
      appendMessage: failure,
      listRecentMessages: failure,
      listMessagesAfter: failure,
      getNode: failure,
      upsertNode: failure,
      supersedeNode: failure,
      updateNodeStatus: failure,
      deleteNode: failure,
      queryNodes: failure,
      appendAuditEvent: failure,
      close() {},
    } as unknown as MemoryStore
    const onWarning = vi.fn()
    const degraded = new MemoryService({ store: failingStore, onWarning })
    const client = modelClient()
    const runtime = new AgentRuntime({ modelClient: client, memory: degraded })

    const result = await runtime.run({ messages: ['hello'], contextKey: 's1' })

    expect(result.output.content).toBe('ok')
    expect(result.memoryContext?.diagnostics).toMatchObject({ storeStatus: 'degraded', enabled: true })
    expect(result.memoryContext?.diagnostics.warnings).toContain('database unavailable')
    expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({ message: 'database unavailable' }))
    degraded.close()
  })

  it('does not report an ephemeral fallback as an empty durable memory store', async () => {
    const ephemeral = new MemoryService({
      store,
      storageMode: 'ephemeral',
      warning: 'persistent database unavailable',
    })
    const search = createMemoryTools(ephemeral).find(tool => tool.definition.name === 'memory_search')!

    await expect(search.execute({ all: true }, {
      sessionId: 's1',
      profileId: 'default',
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('cannot determine whether durable memories exist'),
    })

    const client = modelClient()
    const runtime = new AgentRuntime({ modelClient: client, memory: ephemeral })
    await runtime.run({ messages: ['what do you remember?'], contextKey: 's1' })
    const request = vi.mocked(client.create).mock.calls[0]?.[0] as ModelRequest
    expect(String(request.messages[0]?.content)).toContain('persistent database unavailable')
    expect(String(request.messages[0]?.content)).toContain(
      'Do not interpret empty or missing results as proof that the user has no saved memories',
    )
  })
})

function modelClient(): ModelClient {
  return {
    provider: 'test',
    requestStyle: 'custom-runtime',
    capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
    create: vi.fn(async () => ({ content: 'ok' })),
    stream: vi.fn(),
  }
}

function userPreference(value: string): Partial<MemoryNode> {
  return {
    valueJson: value,
    title: `Avoid ${value}`,
    content: `Avoid ${value} in recommendations.`,
  }
}

function memoryNode(id: string, overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id,
    profileId: 'default',
    domain: 'preference',
    categoryPath: ['preference', 'food', 'avoid'],
    type: 'preference',
    key: 'preference.food.avoid:香菜',
    revision: 1,
    valueJson: '香菜',
    title: id,
    content: id,
    status: 'active',
    confidence: 0.9,
    importance: 0.8,
    tags: [],
    entities: [],
    sourceMessageIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}
