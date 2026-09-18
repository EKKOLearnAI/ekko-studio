import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('chat run webhooks', () => {
  let db: any = null
  const dispatchers: Array<{ stop: () => void }> = []

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
    }))
    vi.doMock('../../packages/server/src/modules/studio/services/auth/token-auth', () => ({
      getToken: async () => 'test-server-token',
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
  })

  afterEach(async () => {
    for (const dispatcher of dispatchers.splice(0)) dispatcher.stop()
    try {
      const { stopChatWebhookDispatcher } = await import(
        '../../packages/server/src/modules/studio/services/webhooks/dispatcher'
      )
      stopChatWebhookDispatcher()
    } catch {}
    vi.useRealTimers()
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.doUnmock('../../packages/server/src/modules/studio/services/auth/token-auth')
    vi.doUnmock('../../packages/server/src/modules/studio/services/social-messages/session-push')
    vi.resetModules()
  })

  async function createEndpoint(overrides: Record<string, unknown> = {}) {
    const { createChatWebhookEndpoint } = await import(
      '../../packages/server/src/modules/studio/repositories/chat-webhook-store'
    )
    return createChatWebhookEndpoint({
      name: 'Operations',
      url: 'https://93.184.216.34/hermes',
      secret: 'server-secret',
      event_types: ['chat.run.completed', 'chat.run.failed'],
      profiles: [],
      enabled: true,
      include_content: false,
      allow_private_network: false,
      max_retries: 3,
      ...overrides,
    })!
  }

  function completedEvent(id: string) {
    return {
      id,
      type: 'chat.run.completed' as const,
      occurred_at: '2026-08-09T00:00:00.000Z',
      profile: 'default',
      source: 'chat' as const,
      agent: 'bridge' as const,
      subject: { session_id: 'session-1', run_id: id, message_id: `message-${id}` },
      summary: { status: 'completed' as const },
      content: `answer-${id}`,
    }
  }

  it('stores multiple endpoint configurations without creating event or delivery history tables', async () => {
    await createEndpoint()
    await createEndpoint({ name: 'Audit', url: 'https://93.184.216.35/audit' })

    const { listChatWebhookEndpoints } = await import(
      '../../packages/server/src/modules/studio/repositories/chat-webhook-store'
    )
    expect(listChatWebhookEndpoints().map(endpoint => endpoint.name)).toEqual(['Operations', 'Audit'])

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'chat_webhook%' ORDER BY name",
    ).all().map((row: { name: string }) => row.name)
    expect(tables).toEqual(['chat_webhook_endpoints'])

    const controller = await import('../../packages/server/src/modules/studio/controllers/chat-webhooks')
    const ctx = { body: null } as any
    await controller.listEndpoints(ctx)
    expect(ctx.body.endpoints).toHaveLength(2)
    expect(ctx.body.endpoints[0]).toMatchObject({ has_secret: true, name: 'Operations' })
    expect(ctx.body.endpoints[0]).toMatchObject({ include_user_content: false })
    expect(JSON.stringify(ctx.body)).not.toContain('server-secret')

    const columns = db.prepare('PRAGMA table_info(chat_webhook_endpoints)').all()
      .map((row: { name: string }) => row.name)
    expect(columns).toContain('include_user_content')
  })

  it('rejects private targets unless explicitly enabled and returns the validated DNS address', async () => {
    const { normalizeSafeWebhookUrl, resolveSafeWebhookTarget } = await import(
      '../../packages/server/src/modules/studio/services/webhooks/url-safety'
    )

    await expect(normalizeSafeWebhookUrl('http://127.0.0.1/hook', false)).rejects.toThrow(
      'Private-network webhook URLs require explicit permission',
    )
    await expect(normalizeSafeWebhookUrl(
      'https://internal.example/hook',
      false,
      (async () => [{ address: '10.0.0.8', family: 4 }]) as any,
    )).rejects.toThrow('private or reserved address')

    const target = await resolveSafeWebhookTarget(
      'https://hooks.example/events',
      false,
      (async () => [{ address: '93.184.216.34', family: 4 }]) as any,
    )
    expect(target).toEqual({
      url: 'https://hooks.example/events',
      address: '93.184.216.34',
      family: 4,
    })
  })

  it('builds metadata-only payloads by default and safely truncates optional final text', async () => {
    const { buildChatWebhookEnvelope, MAX_WEBHOOK_CONTENT_BYTES } = await import(
      '../../packages/server/src/modules/studio/services/webhooks/envelope'
    )
    const event = completedEvent('run-1')
    event.content = '🙂'.repeat(MAX_WEBHOOK_CONTENT_BYTES)

    expect(buildChatWebhookEnvelope(event, false)).not.toHaveProperty('message')
    const included = buildChatWebhookEnvelope(event, true)
    expect(included.message?.id).toBe('message-run-1')
    expect(included.message?.truncated).toBe(true)
    expect(Buffer.byteLength(included.message?.text || '')).toBeLessThanOrEqual(MAX_WEBHOOK_CONTENT_BYTES)
    expect(included.message?.text).not.toContain('�')

    const userEvent = {
      ...completedEvent('message-run'),
      type: 'chat.message.created' as const,
      summary: { status: 'created' as const, role: 'user' as const },
      content: 'private user message',
      content_role: 'user' as const,
    }
    expect(buildChatWebhookEnvelope(userEvent, true, false)).not.toHaveProperty('message')
    expect(buildChatWebhookEnvelope(userEvent, false, true)).toMatchObject({
      type: 'chat.message.created',
      message: { role: 'user', text: 'private user message', truncated: false },
    })
  })

  it('provides a tokenized loopback receiver for testing without another service', async () => {
    const {
      clearLocalChatWebhookTestInbox,
      getLocalChatWebhookTestTarget,
      listLocalChatWebhookTestInbox,
      validateLocalChatWebhookTestDelivery,
    } = await import(
      '../../packages/server/src/modules/studio/services/webhooks/local-test-receiver'
    )
    const target = await getLocalChatWebhookTestTarget()
    const token = new URL(target.url).pathname.split('/').pop()!
    const body = {
      schema_version: 1,
      id: 'event-1',
      type: 'chat.run.completed',
    }

    await expect(validateLocalChatWebhookTestDelivery({
      remoteAddress: '127.0.0.1',
      token,
      event: 'chat.run.completed',
      eventId: 'event-1',
      deliveryId: 'delivery-1',
      timestamp: '1786233600',
      body,
    })).resolves.toMatchObject({
      ok: true,
      status: 200,
      response: { event_id: 'event-1', delivery_id: 'delivery-1' },
    })

    await expect(validateLocalChatWebhookTestDelivery({
      remoteAddress: '203.0.113.8',
      token,
      event: 'chat.run.completed',
      eventId: 'event-1',
      deliveryId: 'delivery-1',
      timestamp: '1786233600',
      body,
    })).resolves.toMatchObject({ ok: false, status: 404 })

    expect(listLocalChatWebhookTestInbox()).toEqual([
      expect.objectContaining({
        event: 'chat.run.completed',
        event_id: 'event-1',
        delivery_id: 'delivery-1',
        payload: body,
      }),
    ])
    clearLocalChatWebhookTestInbox()
    expect(listLocalChatWebhookTestInbox()).toEqual([])
  })

  it('correlates mobile turns without deduplicating separate roots or leaking targets to webhook payloads', async () => {
    const service = await import('../../packages/server/src/modules/studio/services/webhooks/index')
    const { businessEvents } = await import('../../packages/server/src/modules/studio/services/webhooks/business-events')
    const enqueue = vi.spyOn(service.getChatWebhookDispatcher(), 'enqueue').mockReturnValue(true)
    const events: any[] = []
    const unsubscribe = businessEvents.subscribe('test-push-target', event => { events.push(event) })
    const input = { event: 'run.completed', sessionId: 'session-a', profile: 'default', source: 'chat', agent: 'codex' as const, payload: { run_id: 'persistent-agent-session', output: 'done' } }
    service.observeChatRunWebhookEvent({ ...input, pushTargetId: 'root-a' })
    service.observeChatRunWebhookEvent({ ...input, pushTargetId: 'root-b' })
    service.observeChatRunWebhookEvent({ ...input, pushTargetId: 'root-b' })
    unsubscribe()
    expect(events.map(event => event.push_target_id)).toEqual(['root-a', 'root-b', 'root-b'])
    expect(events[0].id).not.toBe(events[1].id)
    expect(events[1].id).toBe(events[2].id)
    expect(enqueue.mock.calls.every(([event]) => !('push_target_id' in event))).toBe(true)
  })

  it('normalizes terminal Chat Run events before enqueueing them', async () => {
    const webhookService = await import('../../packages/server/src/modules/studio/services/webhooks/index')
    const dispatcher = webhookService.getChatWebhookDispatcher()
    const enqueue = vi.spyOn(dispatcher, 'enqueue').mockReturnValue(true)

    expect(webhookService.observeChatRunWebhookEvent({
      event: 'run.completed',
      sessionId: 'session-1',
      profile: 'work',
      source: 'workflow',
      agent: 'codex',
      workflowId: 'workflow-1',
      workflowNodeId: 'node-2',
      payload: {
        run_id: 'run-1',
        message_id: 'message-1',
        output: 'final answer',
        usage: { input_tokens: 11, output_tokens: 7 },
      },
    })).toBe(true)

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat.run.completed',
      profile: 'work',
      source: 'workflow',
      agent: 'codex',
      content: 'final answer',
      subject: expect.objectContaining({
        session_id: 'session-1',
        run_id: 'run-1',
        message_id: 'message-1',
        workflow_id: 'workflow-1',
        workflow_node_id: 'node-2',
      }),
      summary: expect.objectContaining({ input_tokens: 11, output_tokens: 7 }),
    }))
    enqueue.mockRestore()
  })

  it('fans session notifications out from the unified webhook observer', async () => {
    const notifySessionPush = vi.fn(async () => 1)
    vi.doMock('../../packages/server/src/modules/studio/services/social-messages/session-push', () => ({
      notifySessionPush,
    }))
    const webhookService = await import('../../packages/server/src/modules/studio/services/webhooks/index')
    const enqueue = vi.spyOn(webhookService.getChatWebhookDispatcher(), 'enqueue').mockReturnValue(true)
    const base = {
      sessionId: 'session-push',
      profile: 'default',
      source: 'chat',
      agent: 'bridge' as const,
    }

    webhookService.observeChatRunWebhookEvent({
      ...base,
      event: 'run.completed',
      payload: { run_id: 'run-1', output: 'done' },
    })
    webhookService.observeChatRunWebhookEvent({
      ...base,
      event: 'approval.requested',
      payload: { approval_id: 'approval-1', command: 'npm test' },
    })
    webhookService.observeChatRunWebhookEvent({
      ...base,
      event: 'clarify.requested',
      payload: { clarify_id: 'clarify-1', question: 'Continue?' },
    })
    webhookService.observeChatRunWebhookEvent({
      ...base,
      event: 'tool.started',
      payload: { tool_call_id: 'tool-1' },
    })

    await vi.waitFor(() => expect(notifySessionPush).toHaveBeenCalledTimes(3))
    expect(notifySessionPush).toHaveBeenNthCalledWith(
      1,
      'session-push',
      'run.completed',
      { run_id: 'run-1', output: 'done' },
      'bridge',
    )
    expect(notifySessionPush).toHaveBeenNthCalledWith(
      2,
      'session-push',
      'approval.requested',
      { approval_id: 'approval-1', command: 'npm test' },
      'bridge',
    )
    expect(notifySessionPush).toHaveBeenNthCalledWith(
      3,
      'session-push',
      'clarify.requested',
      { clarify_id: 'clarify-1', question: 'Continue?' },
      'bridge',
    )
    enqueue.mockRestore()
  })

  it('normalizes stable message, queue, run, tool, approval, and clarification lifecycle events', async () => {
    const webhookService = await import('../../packages/server/src/modules/studio/services/webhooks/index')
    const dispatcher = webhookService.getChatWebhookDispatcher()
    const enqueue = vi.spyOn(dispatcher, 'enqueue').mockReturnValue(true)
    const base = {
      sessionId: 'session-lifecycle',
      profile: 'default',
      source: 'workflow',
      agent: 'ekko' as const,
      workflowId: 'workflow-1',
      workflowNodeId: 'node-1',
    }

    const inputs = [
      { event: 'message.created', payload: { message_id: 11, role: 'user', content: 'hello', timestamp: 1_786_233_600 } },
      { event: 'run.queued', payload: { queue_id: 'queue-1', queue_length: 2 } },
      { event: 'run.started', payload: { run_id: 'run-1' } },
      { event: 'tool.started', payload: { run_id: 'run-1', tool_call_id: 'tool-1', name: 'read_file', arguments: { path: '/secret' } } },
      { event: 'tool.completed', payload: { run_id: 'run-1', tool_call_id: 'tool-1', name: 'read_file', output: 'secret file contents' } },
      { event: 'tool.failed', payload: { run_id: 'run-1', tool_call_id: 'tool-2', name: 'shell', error: 'secret error' } },
      { event: 'approval.requested', payload: { run_id: 'run-1', approval_id: 'approval-1', tool: 'shell', choices: ['allow', 'deny'], command: 'secret command' } },
      { event: 'approval.resolved', payload: { run_id: 'run-1', approval_id: 'approval-1', choice: 'deny', resolved: true } },
      { event: 'clarify.requested', payload: { run_id: 'run-1', clarify_id: 'clarify-1', choices: ['A', 'B'], question: 'secret question' } },
      { event: 'clarify.resolved', payload: { run_id: 'run-1', clarify_id: 'clarify-1', resolved: true } },
    ]
    for (const input of inputs) {
      expect(webhookService.observeChatRunWebhookEvent({ ...base, ...input })).toBe(true)
    }

    const normalized = enqueue.mock.calls.map(call => call[0])
    expect(normalized.map(event => event.type)).toEqual([
      'chat.message.created',
      'chat.run.queued',
      'chat.run.started',
      'chat.tool.started',
      'chat.tool.completed',
      'chat.tool.failed',
      'chat.approval.requested',
      'chat.approval.resolved',
      'chat.clarification.requested',
      'chat.clarification.resolved',
    ])
    expect(normalized[0]).toMatchObject({
      occurred_at: '2026-08-09T00:00:00.000Z',
      subject: { message_id: '11', workflow_id: 'workflow-1', workflow_node_id: 'node-1' },
      summary: { status: 'created', role: 'user' },
      content: 'hello',
    })
    expect(normalized[3]).toMatchObject({
      subject: { tool_call_id: 'tool-1' },
      summary: { status: 'started', tool_name: 'read_file' },
    })
    expect(JSON.stringify(normalized[3])).not.toContain('/secret')
    expect(JSON.stringify(normalized[4])).not.toContain('secret file contents')
    expect(JSON.stringify(normalized[6])).not.toContain('secret command')
    expect(JSON.stringify(normalized[8])).not.toContain('secret question')
    enqueue.mockRestore()
  })

  it('delivers subscribed group/workflow events through HTTP with content opt-in and no internal target', async () => {
    await createEndpoint({ event_types: ['group.message.created', 'group.clarification.requested', 'workflow.run.completed'], include_content: true })
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch
    const { ChatWebhookDispatcher, getChatWebhookDispatcher } = await import('../../packages/server/src/modules/studio/services/webhooks/dispatcher')
    const dispatcher = new ChatWebhookDispatcher({ fetchImpl })
    dispatchers.push(dispatcher); dispatcher.start()
    const forward = vi.spyOn(getChatWebhookDispatcher(), 'enqueue').mockImplementation(event => dispatcher.enqueue(event))
    try {
      const { publishGroupMessage, publishGroupInteraction, publishDomainEvent } = await import('../../packages/server/src/modules/studio/services/webhooks/domain-events')
      const room = { id: 'room', name: 'Room', summaryProfile: 'default' }
      publishGroupMessage(room, { id: 'message', senderType: 'agent', role: 'assistant', content: 'Group answer' }, [])
      publishGroupInteraction(room, 'group.clarification.requested', 'group-run', 'question')
      publishDomainEvent('workflow.run.completed', 'default', { workflow_id: 'workflow', run_id: 'workflow-run' }, { title: 'Workflow' })
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3))
      const delivered = vi.mocked(fetchImpl).mock.calls.map(([, request]) => JSON.parse(String(request?.body)))
      expect(delivered.map(event => event.type)).toEqual(['group.message.created', 'group.clarification.requested', 'workflow.run.completed'])
      expect(delivered[0].message).toMatchObject({ role: 'assistant', text: 'Group answer' })
      expect(delivered[1].subject).toMatchObject({ room_id: 'room', clarification_id: 'question', run_id: 'group-run' })
      expect(delivered[2].subject).toEqual({ workflow_id: 'workflow', run_id: 'workflow-run' })
      expect(JSON.stringify(delivered)).not.toMatch(/push_target_id|push_token|apns_token/)
    } finally { forward.mockRestore() }
  })

  it.each(['chat', 'workflow'])('publishes %s task progress by plan revision with bounded, allowlisted metadata', async source => {
    const service = await import('../../packages/server/src/modules/studio/services/webhooks/index')
    const enqueue = vi.spyOn(service.getChatWebhookDispatcher(), 'enqueue').mockReturnValue(true)
    const snapshot = {
      session_id: 'plan-session', run_id: 'plan-run', plan_id: 'card', revision: 1,
      execution_state: 'running', created_at: 1786233600000, updated_at: 1786233600100,
      explanation: 'Private explanation', token: 'SECRET', command: 'SECRET',
      plan: [{ id: 'inspect', step: 'Private step', status: 'completed', token: 'SECRET' },
        { id: 'verify', step: 'Verify', status: 'in_progress' }],
    }
    const base = { event: 'plan.updated', sessionId: 'plan-session', profile: 'default', source, agent: 'ekko' as const,
      ...(source === 'workflow' ? { workflowId: 'workflow-a', workflowNodeId: 'node-a' } : {}), payload: snapshot }
    try {
      expect(service.observeChatRunWebhookEvent({ ...base, pushTargetId: 'target-a' })).toBe(true)
      expect(service.observeChatRunWebhookEvent(base)).toBe(false)
      expect(service.observeChatRunWebhookEvent({ ...base, payload: { ...snapshot, revision: 2, execution_state: 'interrupted',
        plan: snapshot.plan.map(step => ({ ...step, status: step.status === 'in_progress' ? 'pending' : step.status })) } })).toBe(true)
      const [first, next] = enqueue.mock.calls.map(([event]) => event)
      expect(first.type).toBe(`${source}.plan.updated`)
      expect(first.id).not.toBe(next.id)
      expect(service.observeChatRunWebhookEvent(base)).toBe(false)
      expect(first.occurred_at).toBe('2026-08-09T00:00:00.100Z')
      expect(first.subject).toMatchObject({ session_id: 'plan-session', run_id: 'plan-run', plan_id: 'card',
        ...(source === 'workflow' ? { workflow_id: 'workflow-a', workflow_node_id: 'node-a' } : {}) })
      expect(first.task_plan?.progress).toEqual({ total: 2, completed: 1, in_progress: 1, pending: 0, percent: 50 })
      expect(next.task_plan).toMatchObject({ execution_state: 'interrupted', progress: { completed: 1, pending: 1, percent: 50 } })
      const hidden = service.buildChatWebhookEnvelope(first, false)
      expect(hidden.task_plan?.plan).toEqual([{ id: 'inspect', status: 'completed' }, { id: 'verify', status: 'in_progress' }])
      expect(JSON.stringify(hidden)).not.toMatch(/Private|SECRET|push_target_id/)
      const included = service.buildChatWebhookEnvelope(first, true)
      expect(included.task_plan?.explanation).toBe('Private explanation')
      expect(included.task_plan?.plan[0].step).toBe('Private step')
      expect(JSON.stringify(included)).not.toContain('SECRET')
      for (const patch of [{ revision: 0 }, { revision: 1.5 }, { execution_state: 'invalid' }, { updated_at: 1e30 },
        { session_id: 'foreign' }, { plan: [] }, { plan: [{ id: 'bad', status: 'unknown', step: 'Bad' }] }]) {
        expect(service.observeChatRunWebhookEvent({ ...base, payload: { ...snapshot, ...patch } })).toBe(false)
      }
      expect(service.observeChatRunWebhookEvent({ ...base, source: 'group_chat' })).toBe(false)
      expect(enqueue).toHaveBeenCalledTimes(2)
    } finally { enqueue.mockRestore() }
  })

  it('sends the built-in test event through the normal signed delivery path', async () => {
    const endpoint = await createEndpoint({ include_content: true })
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch
    const {
      ChatWebhookDispatcher,
      SIGNATURE_HEADER,
    } = await import('../../packages/server/src/modules/studio/services/webhooks/dispatcher')
    const dispatcher = new ChatWebhookDispatcher({ fetchImpl })
    dispatchers.push(dispatcher)

    await expect(dispatcher.testEndpoint(endpoint)).resolves.toMatchObject({ ok: true, status: 204 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [, init] = vi.mocked(fetchImpl).mock.calls[0]
    const headers = init?.headers as Record<string, string>
    const body = JSON.parse(String(init?.body || '{}'))
    expect(headers[SIGNATURE_HEADER]).toMatch(/^sha256=[a-f0-9]{64}$/)
    expect(body).toMatchObject({
      schema_version: 1,
      type: 'chat.run.completed',
      message: { role: 'assistant', text: 'Ekko Studio webhook test', truncated: false },
    })
    expect(dispatcher.getStatus(endpoint.id)).toMatchObject({ state: 'success', delivered: 1 })
  })

  it('keeps one endpoint ordered across a retry while allowing endpoint-level concurrency', async () => {
    const endpoint = await createEndpoint({ max_retries: 1 })
    await createEndpoint({ name: 'Parallel', url: 'https://93.184.216.35/parallel', max_retries: 0 })
    const calls: Array<{ url: string; eventId: string }> = []
    let firstRunAttempt = true
    let releaseFirstAttempt!: () => void
    const firstAttemptGate = new Promise<void>(resolve => { releaseFirstAttempt = resolve })
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const eventId = JSON.parse(String(init?.body || '{}')).id
      calls.push({ url: String(url), eventId })
      if (String(url).includes('93.184.216.34') && eventId === 'run-a' && firstRunAttempt) {
        firstRunAttempt = false
        await firstAttemptGate
        return new Response('temporary', { status: 503 })
      }
      return new Response(null, { status: 204 })
    }) as typeof fetch

    const { ChatWebhookDispatcher } = await import(
      '../../packages/server/src/modules/studio/services/webhooks/dispatcher'
    )
    const dispatcher = new ChatWebhookDispatcher({
      fetchImpl,
      random: () => 0,
      retryBaseMs: 2,
      retryMaxMs: 2,
    })
    dispatchers.push(dispatcher)
    dispatcher.start()
    expect(dispatcher.enqueue(completedEvent('run-a'))).toBe(true)
    expect(dispatcher.enqueue(completedEvent('run-b'))).toBe(true)

    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 1_000
      while (!predicate() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(predicate()).toBe(true)
    }
    await waitFor(() => calls.length >= 2)
    const firstWave = calls.map(call => `${call.url}:${call.eventId}`)
    expect(firstWave).toContain('https://93.184.216.34/hermes:run-a')
    expect(firstWave).toContain('https://93.184.216.35/parallel:run-a')
    expect(calls.filter(call => call.url.includes('93.184.216.34')).map(call => call.eventId)).toEqual(['run-a'])
    releaseFirstAttempt()

    await waitFor(() => calls.filter(call => call.url.includes('93.184.216.34')).length === 3)
    expect(calls.filter(call => call.url.includes('93.184.216.34')).map(call => call.eventId)).toEqual([
      'run-a',
      'run-a',
      'run-b',
    ])
    expect(dispatcher.getStatus(endpoint.id)).toMatchObject({
      delivered: 2,
      failed: 0,
      queued: 0,
      state: 'success',
    })
  })
})
