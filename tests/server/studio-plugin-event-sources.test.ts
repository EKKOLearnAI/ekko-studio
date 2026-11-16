import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mocks = vi.hoisted(() => ({ status: undefined as any, run: undefined as any }))
vi.mock('../../packages/server/src/modules/studio/services/webhooks/business-consumers', () => ({ ensureBusinessConsumers() {} }))
vi.mock('../../packages/server/src/modules/studio/services/webhooks/dispatcher', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/person-display', () => ({ personDisplayEvent: () => ({}) }))
vi.mock('../../packages/server/src/modules/studio/services/webhooks/legacy-app-events', () => ({ bindLegacyAppEvents() {} }))
vi.mock('../../packages/server/src/modules/studio/services/workflow/manager', () => ({ getWorkflowManager() {} }))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({ authenticateUserToken: vi.fn(), isAuthEnabled: () => true }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({ listUserProfiles: () => [] }))
vi.mock('../../packages/server/src/modules/studio/repositories/workflow-run-store', () => ({ getWorkflowRunWithEvidence: () => mocks.run }))
vi.mock('../../packages/server/src/modules/studio/repositories/run-push-store', () => ({ findPushRunLink: () => null, getRunPushTarget: () => null }))
import { businessEvents, type BusinessEvent } from '../../packages/server/src/modules/studio/services/webhooks/business-events'
import { observeChatRunWebhookEvent } from '../../packages/server/src/modules/studio/services/webhooks'
import { WorkflowSocketServer } from '../../packages/server/src/modules/studio/sockets/workflow'
import { pluginEventData } from '../../packages/server/src/modules/studio/services/plugins/events'
import { PluginRuntime } from '../../packages/server/src/modules/studio/services/plugins/runtime'
import { PluginStore } from '../../packages/server/src/modules/studio/services/plugins/store'

it('publishes message/reasoning streams and tool lifecycle observations while keeping private worker streams hidden', () => {
  const received: BusinessEvent[] = [], stop = businessEvents.subscribe('plugin-wire-test', e => { received.push(e) })
  try {
    const input = { profile: 'work', sessionId: 's', source: 'builtin_agent', agent: 'ekko' as const }
    observeChatRunWebhookEvent({ ...input, event: 'message.delta', payload: { delta: 'hello', run_id: 'run' } })
    observeChatRunWebhookEvent({ ...input, event: 'reasoning.delta', payload: { delta: 'thinking', run_id: 'run' } })
    observeChatRunWebhookEvent({ ...input, event: 'tool.started', payload: { name: 'search', tool_call_id: 't', run_id: 'run', apiKey: 'private' } })
    observeChatRunWebhookEvent({ ...input, sessionId: 'person-task-hidden', event: 'message.delta', payload: { delta: 'hidden' } })
    expect(received.map(e => e.type)).toEqual(['chat.message.delta', 'chat.reasoning.delta', 'chat.tool.started'])
    expect(received[0]).toMatchObject({ subject: { session_id: 's', run_id: 'run' }, payload: { delta: 'hello' } })
    expect(received[2].chat?.summary).toMatchObject({ tool_name: 'search', status: 'started' })
  } finally { stop() }
})

it('publishes workflow started and stopped once per run transition, with persisted evidence', () => {
  const received: BusinessEvent[] = [], stop = businessEvents.subscribe('plugin-workflow-test', e => { received.push(e) })
  const nsp = { to: () => ({ emit: vi.fn() }) }
  const server = new WorkflowSocketServer({ of: () => nsp } as any, {
    onRuntimeStatus: (listener: any) => { mocks.status = listener; return () => {} },
    listRuntimeStatuses: () => [], get: () => ({ profile: 'work', name: 'Flow' }),
  } as any)
  try {
    const base = { workflowId: 'flow', runId: 'r', startedAt: 1, updatedAt: 2, completedAt: null, pendingApprovals: [], nodeStatuses: {} }
    mocks.run = { id: 'r', status: 'running', node_sessions: [] }
    mocks.status({ ...base, status: 'running' }); mocks.status({ ...base, status: 'running' })
    mocks.run.status = 'canceled'
    mocks.status({ ...base, status: 'canceled' }); mocks.status({ ...base, status: 'canceled' })
    expect(received.filter(e => e.type !== 'workflow.run.updated').map(e => e.type)).toEqual(['workflow.run.started', 'workflow.run.stopped'])
    expect(received.find(e => e.type === 'workflow.run.stopped')).toMatchObject({ subject: { workflow_id: 'flow', run_id: 'r' }, payload: { state: { status: 'canceled' } } })
  } finally { stop(); server.close() }
})

it('delivers native coding-agent streams and lifecycle events with optional host fields to plugin listeners', async () => {
  const home = mkdtempSync(join(tmpdir(), 'plugin-native-events-'))
  const identity = { userId: 1, profile: 'work', sessionId: 'native-chat', surface: 'coding_agent' }
  const runtime = new PluginRuntime({ directory: home, source: home, enabled: true, config: {}, installedAt: 0,
    manifest: { id: 'native-events', name: 'Native Events', version: '1.0.0', apiVersion: 1, server: 'server.mjs', permissions: ['events'] } },
    identity, new PluginStore(home), { authorize() {}, api: async () => null, emit() {}, log() {} })
  const received: BusinessEvent[] = [], delivered: unknown[] = []
  const stop = businessEvents.subscribe('plugin-native-events', event => { received.push(event) })
  try {
    await runtime.load({ apply(ctx) { ctx.events.on('chat.*', (event, run) => {
      expect(run.signal.aborted).toBe(false)
      delivered.push({ type: event.type, data: event.data, identity: run.identity })
    }) } })
    const input = { profile: 'work', sessionId: 'native-chat', source: 'coding_agent', agent: 'claude-code' as const }
    observeChatRunWebhookEvent({ ...input, event: 'run.started', payload: { run_id: 'native-run' } })
    observeChatRunWebhookEvent({ ...input, event: 'message.delta', payload: { delta: 'hello', run_id: 'native-run' } })
    observeChatRunWebhookEvent({ ...input, event: 'reasoning.delta', payload: { delta: 'thinking', run_id: 'native-run' } })
    observeChatRunWebhookEvent({ ...input, event: 'tool.started', payload: { name: 'search', tool_call_id: 'tool', run_id: 'native-run', apiKey: 'private' } })
    for (const event of received) await runtime.observe({ id: event.id, type: event.type, timestamp: Date.parse(event.occurred_at), identity, data: pluginEventData(event) })
    expect(delivered).toEqual([
      expect.objectContaining({ type: 'chat.run.started', identity, data: expect.objectContaining({ subject: { session_id: 'native-chat', run_id: 'native-run' }, summary: { status: 'started' } }) }),
      expect.objectContaining({ type: 'chat.message.delta', identity, data: expect.objectContaining({ delta: 'hello' }) }),
      expect.objectContaining({ type: 'chat.reasoning.delta', identity, data: expect.objectContaining({ delta: 'thinking' }) }),
      expect.objectContaining({ type: 'chat.tool.started', identity, data: expect.objectContaining({ summary: { status: 'started', tool_name: 'search' } }) }),
    ])
    expect(JSON.stringify(delivered)).not.toContain('private')
    expect(Object.hasOwn(received[0].subject, 'queue_id')).toBe(true)
    expect(received[0].chat?.subject.queue_id).toBeUndefined()
  } finally { stop(); await runtime.close(); rmSync(home, { recursive: true, force: true }) }
})
