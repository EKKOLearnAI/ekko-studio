import { expect, it, vi } from 'vitest'
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
