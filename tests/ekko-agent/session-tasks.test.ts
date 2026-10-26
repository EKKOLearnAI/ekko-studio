import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from '../../packages/ekko-agent/src/runtime/runtime'
import { createDefaultToolRegistry } from '../../packages/ekko-agent/src/tools/registry'
import { ListSessionTasksTool, UpdateSessionTasksTool, type AgentSessionTasksSnapshot } from '../../packages/ekko-agent/src/tools/session-tasks'
import type { AgentToolContext } from '../../packages/ekko-agent/src/tools/types'
import type { ModelClient } from '../../packages/ekko-agent/src/model/types'

const snapshot = (sessionId = 's1'): AgentSessionTasksSnapshot => ({ session_id: sessionId, revision: 2, updated_at: 1, tasks: [
  { id: 'export', title: 'CSV export', summary: 'Implemented and verified', status: 'completed' },
  { id: 'login', title: 'Fix login', summary: 'Pending', status: 'open' },
] })

describe('native session goal queries', () => {
  it('exposes a native writer, validates scope, and propagates revision conflicts without modifying the run plan', async () => {
    const write = vi.fn(() => snapshot())
    const context = { sessionId: 's1', listSessionTasks: () => snapshot(), updateSessionTasks: write, updatePlan: vi.fn() }
    const registry = createDefaultToolRegistry()
    await registry.refreshTools(context)
    const tool = registry.get('update_session_tasks')!
    expect(tool).toBeInstanceOf(UpdateSessionTasksTool)
    expect(tool.concurrency).toBe('serial')
    const update = { revision: 2, changes: [{ id: 'login', title: 'Fix login', summary: 'Tests passed', status: 'completed', completion_evidence: 'Login integration checks pass' }] }
    expect((await tool.execute(update, context)).ok).toBe(true)
    expect(write).toHaveBeenCalledWith(update)
    expect(context.updatePlan).not.toHaveBeenCalled()
    for (const input of [{ ...update, session_id: 'other' }, { ...update, revision: -1 }, { ...update, changes: [] },
      { ...update, changes: [{ ...update.changes[0], status: 'pending' }] }]) {
      expect((await tool.execute(input, context)).ok).toBe(false)
    }
    expect(write).toHaveBeenCalledTimes(1)
    write.mockImplementationOnce(() => { throw new Error('Revision conflict: reread goals') })
    expect(await tool.execute(update, context)).toMatchObject({ ok: false, error: 'Revision conflict: reread goals' })
    await registry.refreshTools({ ...context, delegationDepth: 1 })
    expect(registry.get('update_session_tasks')).toBeUndefined()
    expect((await tool.execute(update, { ...context, delegationDepth: 1 })).ok).toBe(false)
  })

  it('lets the same conversational model review, create, execute, and complete goals in its normal tool loop', async () => {
    let ledger: AgentSessionTasksSnapshot = { session_id: 's1', revision: 0, updated_at: 0, tasks: [] }
    let calls = 0
    const writes = vi.fn((input: any) => {
      expect(input.revision).toBe(ledger.revision)
      ledger = { ...ledger, revision: ledger.revision + 1, tasks: input.changes.map((goal: any) => ({ ...goal, id: 'export' })) }
      return ledger
    })
    const model: ModelClient = {
      provider: 'test', requestStyle: 'custom-runtime',
      capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
      create: vi.fn(async request => {
        expect(request.tools?.some(tool => tool.name === 'update_session_tasks')).toBe(true)
        calls++
        const goal = { title: 'CSV export', summary: 'Requested', status: 'open' }
        if (calls === 1) return { content: '', toolCalls: [{ id: 'read', name: 'list_session_tasks', arguments: {} }] }
        if (calls === 2) return { content: '', toolCalls: [{ id: 'create', name: 'update_session_tasks', arguments: { revision: 0, changes: [goal] } }] }
        if (calls === 3) {
          expect(ledger.tasks[0].status).toBe('open')
          return { content: 'CSV export implementation and checks succeeded.', toolCalls: [{ id: 'complete', name: 'update_session_tasks', arguments: {
            revision: 1, changes: [{ ...goal, id: 'export', status: 'completed', summary: 'Delivered', completion_evidence: 'CSV export integration tests pass' }],
          } }] }
        }
        return { content: 'CSV export is ready.' }
      }), stream: vi.fn(),
    }
    const runtime = new AgentRuntime({ modelClient: model, maxSteps: 5, skillsEnabled: false })
    const onPlanUpdate = vi.fn()
    const result = await runtime.run({ messages: [{ role: 'user', content: 'Add CSV export' }],
      toolContext: { sessionId: 's1', listSessionTasks: () => ledger, updateSessionTasks: writes }, onPlanUpdate })
    expect(result.output.content).toBe('CSV export is ready.')
    expect(writes).toHaveBeenCalledTimes(2)
    expect(ledger.tasks[0].status).toBe('completed')
    expect(onPlanUpdate).not.toHaveBeenCalled()
    expect(result.events.filter(event => event.type === 'tool.completed')).toHaveLength(3)
  })

  it('is discovered only with a host reader and disappears when the runtime changes scope', async () => {
    const registry = createDefaultToolRegistry()
    expect(registry.get('list_session_tasks')).toBeUndefined()
    const context = { sessionId: 's1', listSessionTasks: () => snapshot() }
    await registry.refreshTools(context)
    expect(registry.get('list_session_tasks')).toBeInstanceOf(ListSessionTasksTool)
    expect(registry.get('update_plan')).toBeDefined()
    await registry.refreshTools({ ...context, delegationDepth: 1 })
    expect(registry.get('list_session_tasks')).toBeUndefined()
    await registry.refreshTools(context)
    await registry.refreshTools({ sessionId: 'standalone' })
    expect(registry.get('list_session_tasks')).toBeUndefined()
  })

  it('reads a cloned goal ledger without changing the host snapshot or run plan', async () => {
    const ledger = snapshot()
    const reader = vi.fn(() => ledger)
    const updatePlan = vi.fn()
    const result = await new ListSessionTasksTool().execute({}, { sessionId: 's1', listSessionTasks: reader, updatePlan })
    expect(result.ok).toBe(true)
    expect(JSON.parse(result.content)).toEqual(ledger)
    ;(result.data as AgentSessionTasksSnapshot).tasks[0].status = 'open'
    expect(ledger.tasks[0].status).toBe('completed')
    expect(updatePlan).not.toHaveBeenCalled()
    expect(reader).toHaveBeenCalledWith()
  })

  it('exposes closed goals to the model while keeping closed out of model writes', async () => {
    const ledger = snapshot()
    ledger.tasks[0].status = 'closed'
    const writer = vi.fn(() => ledger)
    const context = { sessionId: 's1', listSessionTasks: () => ledger, updateSessionTasks: writer }
    const read = await new ListSessionTasksTool().execute({}, context)
    expect(read.ok).toBe(true)
    expect(JSON.parse(read.content).tasks[0].status).toBe('closed')
    const write = await new UpdateSessionTasksTool().execute({ revision: 0,
      changes: [{ title: 'Export', summary: 'Closed by user', status: 'closed' }] }, context)
    expect(write.ok).toBe(false)
    expect(writer).not.toHaveBeenCalled()
  })

  it.each([{ session_id: 'other' }, { profile: 'other' }, { status: 'completed' }])('rejects caller-selected scope or writes: %j', async input => {
    const reader = vi.fn(() => snapshot())
    const result = await new ListSessionTasksTool().execute(input, { sessionId: 's1', listSessionTasks: reader })
    expect(result.ok).toBe(false)
    expect(reader).not.toHaveBeenCalled()
  })

  it('rejects unbound, delegated, cancelled and foreign-session results', async () => {
    const tool = new ListSessionTasksTool()
    const reader = vi.fn(() => snapshot())
    const aborted = new AbortController(); aborted.abort()
    const contexts: Array<AgentToolContext | undefined> = [undefined, { sessionId: 's1' },
      { sessionId: 's1', listSessionTasks: reader, delegationDepth: 1 },
      { sessionId: 's1', listSessionTasks: reader, signal: aborted.signal }]
    for (const context of contexts) expect((await tool.execute({}, context)).ok).toBe(false)
    expect(reader).not.toHaveBeenCalled()
    const foreign = await tool.execute({}, { sessionId: 's1', listSessionTasks: () => snapshot('foreign') })
    expect(foreign.ok).toBe(false)
    expect(foreign.data).toBeUndefined()
  })

  it('passes native definitions to the model, records tool calls, and binds successive runs independently', async () => {
    let calls = 0
    const model: ModelClient = {
      provider: 'test', requestStyle: 'custom-runtime',
      capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
      create: vi.fn(async request => {
        calls++
        expect(request.tools?.some(tool => tool.name === 'list_session_tasks')).toBe(true)
        expect(request.tools?.some(tool => tool.name === 'update_plan')).toBe(true)
        expect(request.messages[0].content).toContain('## Session Goals')
        expect(request.messages[0].content).toContain('At the beginning of every turn')
        return calls % 2 ? { content: '', toolCalls: [{ id: `goals-${calls}`, name: 'list_session_tasks', arguments: {} }] }
          : { content: 'The session has one unfinished goal.' }
      }),
      stream: vi.fn(),
    }
    const runtime = new AgentRuntime({ modelClient: model, maxSteps: 3, skillsEnabled: false })
    for (const sessionId of ['s1', 's2']) {
      const onPlanUpdate = vi.fn()
      const result = await runtime.run({ messages: [{ role: 'user', content: 'What remains in this session?' }],
        toolContext: { sessionId, listSessionTasks: () => snapshot(sessionId) }, onPlanUpdate })
      const toolResult = result.messages.find(message => message.role === 'tool' && message.name === 'list_session_tasks')!
      expect(JSON.parse(toolResult.content).session_id).toBe(sessionId)
      expect(result.events.some(event => event.type === 'tool.completed' && event.toolName === 'list_session_tasks')).toBe(true)
      expect(onPlanUpdate).not.toHaveBeenCalled()
    }
  })
})
