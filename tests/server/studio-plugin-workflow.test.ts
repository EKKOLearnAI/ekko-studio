import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), addMessage: vi.fn(), updateSessionStats: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/plugins/host', () => ({ getPluginManager: () => ({ runtime: () => ({ invoke: mocks.invoke, actions: new Map([['capture', { inputSchema: { properties: { input: { type: 'string' } } } }]]) }) }) }))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ addMessage: mocks.addMessage, updateSessionStats: mocks.updateSessionStats }))
import { runPluginWorkflow, cancelPluginWorkflow } from '../../packages/server/src/modules/studio/services/plugins/workflow'
import { exportWorkflowDefinition } from '../../packages/server/src/modules/studio/services/workflow/portability'
beforeEach(() => vi.clearAllMocks())
const identity = { userId: 7, profile: 'work', sessionId: 'node-session', runId: 'workflow-run', surface: 'workflow' }
it('passes upstream text into declared action input and saves output to the workflow node session', async () => {
  mocks.invoke.mockResolvedValue({ saved: true })
  expect(await runPluginWorkflow('notes/capture', '{"tag":"daily"}', 'upstream output', identity)).toEqual({ ok: true, output: '{"saved":true}' })
  expect(mocks.invoke).toHaveBeenCalledWith('action', 'capture', { tag: 'daily', input: 'upstream output' }, identity, expect.any(AbortSignal))
  expect(mocks.addMessage).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'node-session', role: 'assistant', content: '{"saved":true}' }))
})
it('propagates workflow stop to the running action and records no successful output', async () => {
  mocks.invoke.mockImplementation((_kind, _name, _args, _identity, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))))
  const result = runPluginWorkflow('notes/capture', '{}', 'input', identity)
  cancelPluginWorkflow(identity.runId)
  expect(await result).toEqual({ ok: false, error: 'Workflow canceled' })
  expect(mocks.addMessage).not.toHaveBeenCalled()
})
it('preserves plugin action definitions when exporting workflows and rejects embedded credential arguments', () => {
  const workflow = { name: 'Plugin workflow', nodes: [{ id: 'one', type: 'agent', data: { title: 'Capture', pluginAction: 'notes/capture', pluginInput: '{"tag":"daily"}' } }], edges: [], viewport: null } as any
  expect(exportWorkflowDefinition(workflow).definition.nodes[0].data).toMatchObject({ pluginAction: 'notes/capture', pluginInput: '{"tag":"daily"}' })
  workflow.nodes[0].data.pluginInput = '{"password":"secret"}'
  expect(() => exportWorkflowDefinition(workflow)).toThrow(/credential/)
})
