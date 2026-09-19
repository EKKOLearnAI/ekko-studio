import { afterAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const originalWorkflowManagerTestDbDir = process.env.HERMES_WEB_UI_TEST_DB_DIR
const originalWorkflowManagerWebUiHome = process.env.HERMES_WEB_UI_HOME
const originalWorkflowManagerStateDir = process.env.HERMES_WEBUI_STATE_DIR
const workflowManagerTestRoot = mkdtempSync(join(tmpdir(), 'hermes-workflow-manager-'))
const workflowManagerTestDbDir = join(workflowManagerTestRoot, 'db')
const workflowManagerTestHome = join(workflowManagerTestRoot, 'home')
process.env.HERMES_WEB_UI_TEST_DB_DIR = workflowManagerTestDbDir
process.env.HERMES_WEB_UI_HOME = workflowManagerTestHome
process.env.HERMES_WEBUI_STATE_DIR = workflowManagerTestHome

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

const chatRunMock = vi.hoisted(() => ({
  runAndWait: vi.fn(),
  abortSession: vi.fn(),
  sessionOutputs: new Map<string, string>(),
}))

const workflowSkillResolverMock = vi.hoisted(() => ({
  resolve: null as null | ((args: { agent?: string; profile: string; skillName: string }) => Promise<any>),
}))

vi.mock('../../packages/server/src/modules/studio/services/workflow/skill-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/server/src/modules/studio/services/workflow/skill-resolver')>()
  return {
    ...actual,
    resolveWorkflowSkillContent: (args: { agent?: string; profile: string; skillName: string }) => (
      workflowSkillResolverMock.resolve
        ? workflowSkillResolverMock.resolve(args)
        : Promise.resolve(null)
    ),
  }
})

vi.mock('../../packages/server/src/modules/studio/public/workflow-runtime', () => ({
  isWorkflowRunCoordinatorAvailable: () => true,
  runWorkflowAndWait: (input: Record<string, unknown>, options: Record<string, unknown>) => chatRunMock.runAndWait(input, options),
  abortWorkflowSession: (sessionId: string, reason: string) => chatRunMock.abortSession(sessionId, reason),
  stopWorkflowAgentRun: vi.fn(),
  deleteWorkflowPrimaryAgentSession: vi.fn(async () => true),
  getWorkflowAvailableModelGroups: vi.fn(async () => []),
}))

vi.mock('../../packages/server/src/modules/studio/services/agent-availability', () => ({
  assertAgentAvailable: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/server/src/modules/studio/repositories/session-store')>()
  return {
    ...actual,
    getSession: vi.fn(() => null),
    getSessionDetail: vi.fn((sessionId: string) => ({
      messages: [{ role: 'assistant', content: chatRunMock.sessionOutputs.get(sessionId) || `output:${sessionId}` }],
    })),
    deleteSession: vi.fn(),
  }
})

afterAll(async () => {
  const { closeDb } = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
  closeDb()
  restoreEnvironmentVariable('HERMES_WEB_UI_TEST_DB_DIR', originalWorkflowManagerTestDbDir)
  restoreEnvironmentVariable('HERMES_WEB_UI_HOME', originalWorkflowManagerWebUiHome)
  restoreEnvironmentVariable('HERMES_WEBUI_STATE_DIR', originalWorkflowManagerStateDir)
  rmSync(workflowManagerTestRoot, { recursive: true, force: true })
})

describe('workflow manager', () => {
  it('isolates both SQLite and default workflow workspaces for this suite', async () => {
    const { config } = await import('../../packages/server/src/modules/studio/public/config')
    const { getStoragePath } = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { createWorkflow, deleteWorkflow } = await import('../../packages/server/src/modules/studio/repositories/workflow-store')

    expect(getStoragePath()).toBe(join(workflowManagerTestDbDir, 'hermes-web-ui.db'))
    expect(config.appHome).toBe(workflowManagerTestHome)

    initAllStores()
    const workflow = createWorkflow({ name: 'Isolated workspace', profile: 'default' })
    try {
      expect(workflow.workspace).toBe(join(workflowManagerTestHome, 'workflow', 'default', workflow.id))
      expect(existsSync(workflow.workspace!)).toBe(true)
    } finally {
      deleteWorkflow(workflow.id)
    }
  })

  it('returns a server-wide singleton instance', async () => {
    const { WorkflowManager, getWorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')

    const first = getWorkflowManager()
    const second = getWorkflowManager()

    expect(first).toBe(second)
    expect(first).toBeInstanceOf(WorkflowManager)
  })

  it('stores and emits workflow runtime status updates', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const manager = new WorkflowManager()
    const updates: unknown[] = []
    const dispose = manager.onRuntimeStatus(status => updates.push(status))

    const status = manager.setRuntimeStatus('workflow-1', {
      status: 'running',
      runId: 'run-1',
      startedAt: 123,
    })

    expect(status).toMatchObject({
      workflowId: 'workflow-1',
      status: 'running',
      runId: 'run-1',
      startedAt: 123,
      completedAt: null,
      error: null,
    })
    expect(manager.getRuntimeStatus('workflow-1')).toBe(status)
    expect(manager.listRuntimeStatuses()).toEqual([status])
    expect(updates).toEqual([status])

    dispose()
    manager.setRuntimeStatus('workflow-1', { status: 'completed', completedAt: 456 })
    expect(updates).toEqual([status])
  })

  it('maps workflow node agents to the existing run backends', async () => {
    const { resolveWorkflowNodeRunTarget } = await import('../../packages/server/src/modules/studio/services/workflow/manager')

    expect(resolveWorkflowNodeRunTarget('dsh')).toEqual({ type: 'workflow', source: 'workflow', agent: 'dsh', codingAgentId: 'dsh' })
    expect(resolveWorkflowNodeRunTarget('hermes')).toEqual({
      type: 'workflow',
      source: 'workflow',
      agent: 'hermes',
    })
    expect(resolveWorkflowNodeRunTarget('ekko-agent')).toEqual({
      type: 'workflow',
      source: 'workflow',
      agent: 'ekko-agent',
      codingAgentId: 'ekko-agent',
    })
    expect(resolveWorkflowNodeRunTarget('claude-code')).toEqual({
      type: 'workflow',
      source: 'workflow',
      agent: 'claude',
      codingAgentId: 'claude-code',
    })
    expect(resolveWorkflowNodeRunTarget('codex')).toEqual({
      type: 'workflow',
      source: 'workflow',
      agent: 'codex',
      codingAgentId: 'codex',
    })
    expect(resolveWorkflowNodeRunTarget('pi')).toEqual({
      type: 'workflow',
      source: 'workflow',
      agent: 'pi',
      codingAgentId: 'pi',
    })
    expect(() => resolveWorkflowNodeRunTarget('unknown')).toThrow('unsupported workflow Agent runtime: unknown')
    expect(() => resolveWorkflowNodeRunTarget()).toThrow('unsupported workflow Agent runtime')
  })

  it('requires workflow node approval only when explicitly enabled', async () => {
    const { workflowNodeRequiresApproval } = await import('../../packages/server/src/modules/studio/services/workflow/manager')

    expect(workflowNodeRequiresApproval({ data: { approvalRequired: true } })).toBe(true)
    expect(workflowNodeRequiresApproval({ data: { approvalRequired: false } })).toBe(false)
    expect(workflowNodeRequiresApproval({ data: {} })).toBe(false)
  })

  it('rejects unsupported node types and agent runtimes instead of silently falling back to Hermes', async () => {
    const { normalizeWorkflowNode } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    expect(() => normalizeWorkflowNode({ id: 'shell', type: 'shell', data: { agent: 'hermes' } })).toThrow('workflow node shell must be an Agent node')
    expect(() => normalizeWorkflowNode({ id: 'unknown', type: 'agent', data: { agent: 'python' } })).toThrow('workflow node unknown has unsupported agent runtime')
    expect(normalizeWorkflowNode({ id: 'hermes', type: 'agent', data: { agent: 'hermes' } })?.data.agent).toBe('hermes')
    expect(normalizeWorkflowNode({ id: 'ekko', type: 'agent', data: { agent: 'ekko-agent' } })?.data.agent).toBe('ekko-agent')
    expect(normalizeWorkflowNode({ id: 'claude', type: 'agent', data: { agent: 'claude-code' } })?.data.agent).toBe('claude-code')
    expect(normalizeWorkflowNode({ id: 'codex', type: 'agent', data: { agent: 'codex' } })?.data.agent).toBe('codex')
    expect(normalizeWorkflowNode({ id: 'pi', type: 'agent', data: { agent: 'pi' } })?.data.agent).toBe('pi')
    expect(normalizeWorkflowNode({ id: 'legacy-mode', type: 'agent', data: { agent: 'codex' } })?.data.agentMode).toBe('scoped')
    expect(normalizeWorkflowNode({ id: 'global-mode', type: 'agent', data: { agent: 'codex', agentMode: 'global' } })?.data.agentMode).toBe('global')
    expect(() => normalizeWorkflowNode({ id: 'bad-global', type: 'agent', data: { agent: 'ekko-agent', agentMode: 'global' } }))
      .toThrow('workflow node bad-global cannot use global mode')
  })

  it('normalizes workflow node join mode and rejects malformed explicit values', async () => {
    const { normalizeWorkflowNode } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    expect(normalizeWorkflowNode({ id: 'legacy', type: 'agent', data: {} })?.data.orchestration).toEqual({ join: 'all' })
    expect(normalizeWorkflowNode({ id: 'any', type: 'agent', data: { orchestration: { join: 'any' } } })?.data.orchestration).toEqual({ join: 'any' })
    expect(normalizeWorkflowNode({ id: 'positioned', type: 'agent', position: { x: -240, y: 360 }, data: {} })?.position).toEqual({ x: -240, y: 360 })
    expect(() => normalizeWorkflowNode({ id: 'bad', type: 'agent', data: { orchestration: { join: 'some' } } })).toThrow('workflow node bad has invalid orchestration join')
  })

  it('ignores removed legacy execution-policy fields while preserving the upstream execution identity', async () => {
    const { normalizeWorkflowNode } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const normalized = normalizeWorkflowNode({ id: 'legacy-policy', type: 'agent', data: {
      agent: 'hermes', provider: 'custom:test', model: 'model-a', apiMode: 'chat_completions',
      reasoningEffort: 'high', executionPolicy: {
        allowedToolsets: [], allowedTools: ['browser_click'], skipMemory: true, skipContextFiles: false,
      },
    } })
    expect(normalized?.data).toMatchObject({
      provider: 'custom:test', model: 'model-a', apiMode: 'chat_completions', reasoningEffort: 'high',
    })
    expect(normalized?.data).not.toHaveProperty('executionPolicy')
    expect(() => normalizeWorkflowNode({ id: 'malformed-legacy-policy', type: 'agent', data: {
      executionPolicy: { allowedToolsets: 'browser' },
    } })).not.toThrow()
  })

  it('strips removed legacy execution-policy fields from embedded edge node copies at every persistence boundary', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { createWorkflow, getWorkflow } = await import('../../packages/server/src/modules/studio/repositories/workflow-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    const legacyPolicy = { allowedToolsets: [], allowedTools: ['terminal'], skipMemory: true, skipContextFiles: true }
    const raw = createWorkflow({
      name: `Legacy embedded policy ${Date.now()}`,
      profile: 'default',
      nodes: [
        { id: 'source', type: 'agent', data: { agent: 'hermes', executionPolicy: legacyPolicy } },
        { id: 'target', type: 'agent', data: { agent: 'hermes' } },
      ],
      edges: [{
        id: 'source-target', source: 'source', target: 'target',
        sourceNode: { id: 'source', type: 'agent', data: { agent: 'hermes', executionPolicy: legacyPolicy } },
        targetNode: { id: 'target', type: 'agent', data: { agent: 'hermes', executionPolicy: legacyPolicy } },
      } as any],
    } as any)
    try {
      expect(JSON.stringify(manager.get(raw.id))).not.toContain('executionPolicy')
      expect(JSON.stringify(manager.list().find(workflow => workflow.id === raw.id))).not.toContain('executionPolicy')
      expect(JSON.stringify(manager.update(raw.id, { name: `${raw.name} updated` }))).not.toContain('executionPolicy')
      expect(JSON.stringify(getWorkflow(raw.id))).not.toContain('executionPolicy')

      const created = manager.create({
        name: `Create embedded policy ${Date.now()}`,
        profile: 'default',
        nodes: raw.nodes,
        edges: raw.edges,
      })
      try {
        expect(JSON.stringify(created)).not.toContain('executionPolicy')
        expect(JSON.stringify(getWorkflow(created.id))).not.toContain('executionPolicy')
      } finally { await manager.delete(created.id) }
    } finally { await manager.delete(raw.id) }
  })

  it('freezes the selected target but leaves Hermes api mode owned by its provider profile', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'done' })
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: `Exact execution tuple ${Date.now()}`, profile: 'default',
      nodes: [{ id: 'agent', type: 'agent', position: { x: -240, y: 360 }, data: {
        title: 'Agent', agent: 'hermes', provider: 'custom:test', model: 'model-a',
        apiMode: 'chat_completions', reasoningEffort: 'high', input: 'work',
        executionPolicy: { allowedToolsets: [], allowedTools: ['browser_click'], skipMemory: true, skipContextFiles: true },
      } }], edges: [],
    })
    expect(workflow.nodes[0]?.data).not.toHaveProperty('executionPolicy')
    try {
      const result = await manager.runNow(workflow.id, { user: { id: 42, username: 'owner', role: 'super_admin' } })
      expect(result.run.status).toBe('completed')
      expect(result.run.user_id).toBe(42)
      expect(result.run.snapshot_nodes[0]).toMatchObject({ data: {
        provider: 'custom:test', model: 'model-a', apiMode: 'chat_completions', reasoningEffort: 'high',
      } })
      expect(result.run.snapshot_nodes[0]?.position).toEqual({ x: -240, y: 360 })
      expect(result.run.snapshot_nodes[0]?.data).not.toHaveProperty('executionPolicy')
      expect(chatRunMock.runAndWait).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'custom:test', model: 'model-a', one_shot_model: true, reasoning_effort: 'high',
        background_delegation_enabled: false,
      }), expect.any(Object))
      expect(chatRunMock.runAndWait.mock.calls[0]?.[0]).not.toHaveProperty('apiMode')
      expect(chatRunMock.runAndWait.mock.calls[0]?.[0]).not.toHaveProperty('execution_policy')
    } finally { await manager.delete(workflow.id) }
  })

  it('preserves authored visual graph fields in an immutable run snapshot', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    chatRunMock.sessionOutputs.clear()
    chatRunMock.runAndWait.mockReset().mockImplementation(async (request: { session_id: string }) => {
      const output = chatRunMock.runAndWait.mock.calls.length === 1 ? '{"decision":"READY"}' : 'delivered'
      chatRunMock.sessionOutputs.set(request.session_id, output)
      return { ok: true, output }
    })
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: `Visual run snapshot ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'plan', type: 'agent', position: { x: -320, y: -40 }, data: { title: 'Plan', agent: 'hermes', input: 'plan' } },
        { id: 'delivery', type: 'agent', position: { x: 1_860, y: 265 }, data: { title: 'Delivery', agent: 'hermes', input: 'deliver' } },
      ],
      edges: [{
        id: 'plan-delivery-ready', source: 'plan', target: 'delivery',
        sourceHandle: 'top', targetHandle: 'bottom', label: 'READY path', animated: true,
        sourceNode: { id: 'plan', runtimeOnly: true }, targetNode: { id: 'delivery', runtimeOnly: true },
        sourceX: 123, targetX: 456, events: { click: 'runtime-only' },
        data: { orchestration: {
          route: 'success', condition: { path: 'outputJson.decision', operator: 'equals', value: 'READY' },
        } },
      } as any],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('completed')
      expect(result.run.snapshot_nodes.map((node: any) => ({ id: node.id, position: node.position }))).toEqual([
        { id: 'plan', position: { x: -320, y: -40 } },
        { id: 'delivery', position: { x: 1_860, y: 265 } },
      ])
      expect(result.run.snapshot_edges).toEqual([expect.objectContaining({
        id: 'plan-delivery-ready', source: 'plan', target: 'delivery',
        sourceHandle: 'top', targetHandle: 'bottom', label: 'READY path', animated: true,
        data: { orchestration: {
          route: 'success', condition: { path: 'outputJson.decision', operator: 'equals', value: 'READY' },
        } },
      })])
      expect(result.run.snapshot_edges[0]).not.toHaveProperty('sourceNode')
      expect(result.run.snapshot_edges[0]).not.toHaveProperty('targetNode')
      expect(result.run.snapshot_edges[0]).not.toHaveProperty('sourceX')
      expect(result.run.snapshot_edges[0]).not.toHaveProperty('targetX')
      expect(result.run.snapshot_edges[0]).not.toHaveProperty('events')
      expect(result.run.snapshot_edges[0]).not.toHaveProperty('orchestration')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)

      const rerun = await manager.rerunFromNode(workflow.id, result.run.id, 'delivery')
      expect(rerun.run.status).toBe('completed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(3)
    } finally { await manager.delete(workflow.id) }
  })

  it.each(['codex', 'pi'] as const)('continues forwarding api mode for %s workflow nodes', async (agent) => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'done' })
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: `${agent} api mode ${Date.now()}`,
      profile: 'default',
      nodes: [{ id: 'agent', type: 'agent', data: {
        title: 'Agent', agent, provider: 'custom:test', model: 'model-a',
        apiMode: 'chat_completions', reasoningEffort: 'high', input: 'work',
      } }],
      edges: [],
    })
    try {
      await manager.runNow(workflow.id)
      expect(chatRunMock.runAndWait).toHaveBeenCalledWith(expect.objectContaining({
        coding_agent_id: agent, apiMode: 'chat_completions', reasoning_effort: 'high',
      }), expect.any(Object))
      expect(chatRunMock.runAndWait.mock.calls[0]?.[0]).not.toHaveProperty('background_delegation_enabled')
    } finally { await manager.delete(workflow.id) }
  })

  it('runs global Codex workflow nodes without injecting scoped model configuration', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { getDb } = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'done' })
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: `Global Codex execution ${Date.now()}`,
      profile: 'default',
      nodes: [{ id: 'agent', type: 'agent', data: {
        title: 'Global Codex', agent: 'codex', agentMode: 'global',
        provider: 'must-not-leak', model: 'must-not-leak', apiMode: 'chat_completions',
        reasoningEffort: 'high', input: 'work',
      } }],
      edges: [],
    })
    try {
      const result = await manager.runNow(workflow.id)
      const runInput = chatRunMock.runAndWait.mock.calls[0]?.[0]
      expect(runInput).toMatchObject({
        coding_agent_id: 'codex',
        agent_id: 'codex',
        mode: 'global',
        profile: 'default',
        one_shot_model: true,
      })
      expect(runInput).not.toHaveProperty('provider')
      expect(runInput).not.toHaveProperty('model')
      expect(runInput).not.toHaveProperty('apiMode')
      expect(runInput).not.toHaveProperty('reasoning_effort')
      expect(result.nodeSessions[0]).toMatchObject({
        agent: 'codex',
        agent_mode: 'global',
        status: 'completed',
      })
      expect(getDb()!.prepare(`SELECT source, agent, agent_mode, provider, model, api_mode FROM sessions WHERE id = ?`)
        .get(result.nodeSessions[0]!.session_id)).toEqual({
          source: 'workflow',
          agent: 'codex',
          agent_mode: 'global',
          provider: 'global',
          model: '',
          api_mode: '',
        })
    } finally { await manager.delete(workflow.id) }
  })

  it('keeps a selected DSH preset in workflow snapshots and execution', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { getDb } = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'done' })
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: `DSH preset execution ${Date.now()}`,
      profile: 'default',
      nodes: [{ id: 'agent', type: 'agent', data: {
        title: 'DSH preset', agent: 'dsh', agentMode: 'global',
        provider: 'must-not-leak', model: 'must-not-leak', apiMode: 'chat_completions',
        reasoningEffort: 'high', agentPreset: 'minimal', input: 'work',
      } }],
      edges: [],
    })
    try {
      const result = await manager.runNow(workflow.id)
      const runInput = chatRunMock.runAndWait.mock.calls[0]?.[0]
      expect(runInput).toMatchObject({
        coding_agent_id: 'dsh',
        agent_id: 'dsh',
        mode: 'global',
        agent_preset: 'minimal',
        profile: 'default',
        one_shot_model: true,
      })
      expect(runInput).not.toHaveProperty('provider')
      expect(runInput).not.toHaveProperty('model')
      expect(runInput).not.toHaveProperty('apiMode')
      expect(runInput).not.toHaveProperty('reasoning_effort')
      expect(result.nodeSessions[0]).toMatchObject({
        agent: 'dsh',
        agent_mode: 'global',
        status: 'completed',
      })
      expect(getDb()!.prepare(`SELECT source, agent, agent_mode, provider, model, api_mode FROM sessions WHERE id = ?`)
        .get(result.nodeSessions[0]!.session_id)).toEqual({
          source: 'workflow',
          agent: 'dsh',
          agent_mode: 'global',
          provider: 'global',
          model: '',
          api_mode: '',
        })
    } finally { await manager.delete(workflow.id) }
  })

  it('runs Ekko workflow nodes as scoped one-shot executions without background delegation', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { getDb } = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'done' })
    const manager = new WorkflowManager()
    const workflow = manager.create({
      name: `Ekko execution ${Date.now()}`,
      profile: 'default',
      nodes: [{ id: 'agent', type: 'agent', data: {
        title: 'Ekko', agent: 'ekko-agent', provider: 'openai-codex', model: 'gpt-test',
        apiMode: 'codex_responses', reasoningEffort: 'high', input: 'work',
      } }],
      edges: [],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('completed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledWith(expect.objectContaining({
        coding_agent_id: 'ekko-agent',
        agent_id: 'ekko-agent',
        mode: 'scoped',
        provider: 'openai-codex',
        model: 'gpt-test',
        apiMode: 'codex_responses',
        reasoning_effort: 'high',
        one_shot_model: true,
        background_delegation_enabled: false,
      }), expect.any(Object))
      expect(result.nodeSessions[0]).toMatchObject({
        agent: 'ekko-agent',
        agent_mode: 'scoped',
        status: 'completed',
      })
      expect(getDb()!.prepare(`SELECT source, agent, agent_mode, provider, model, api_mode FROM sessions WHERE id = ?`)
        .get(result.nodeSessions[0]!.session_id)).toEqual({
          source: 'workflow',
          agent: 'ekko-agent',
          agent_mode: 'scoped',
          provider: 'openai-codex',
          model: 'gpt-test',
          api_mode: 'codex_responses',
        })
    } finally { await manager.delete(workflow.id) }
  })

  it('forwards workflow images to coding-agent nodes as ContentBlock input', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'done' })
    const manager = new WorkflowManager()
    const imagePath = '/tmp/workflow-reference.png'
    const workflow = manager.create({
      name: `Coding Agent image input ${Date.now()}`,
      profile: 'default',
      nodes: [{ id: 'agent', type: 'agent', data: {
        title: 'Agent', agent: 'codex', provider: 'custom:test', model: 'model-a',
        apiMode: 'codex_responses', input: 'inspect the reference', images: [imagePath],
      } }],
      edges: [],
    })
    try {
      await manager.runNow(workflow.id)
      expect(chatRunMock.runAndWait).toHaveBeenCalledWith(expect.objectContaining({
        coding_agent_id: 'codex',
        input: [
          { type: 'text', text: '[Current task]\ninspect the reference' },
          {
            type: 'image',
            name: 'workflow-reference.png',
            path: imagePath,
            media_type: 'image/png',
          },
        ],
      }), expect.any(Object))
    } finally { await manager.delete(workflow.id) }
  })

  it('forwards workflow files as file ContentBlocks instead of mislabeled images', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'done' })
    const manager = new WorkflowManager()
    const filePath = '/tmp/workflow-reference.pdf'
    const workflow = manager.create({
      name: `Coding Agent file input ${Date.now()}`,
      profile: 'default',
      nodes: [{ id: 'agent', type: 'agent', data: {
        title: 'Agent', agent: 'codex', provider: 'custom:test', model: 'model-a',
        apiMode: 'codex_responses', input: 'inspect the reference', images: [filePath],
      } }],
      edges: [],
    })
    try {
      await manager.runNow(workflow.id)
      expect(chatRunMock.runAndWait).toHaveBeenCalledWith(expect.objectContaining({
        coding_agent_id: 'codex',
        input: [
          { type: 'text', text: '[Current task]\ninspect the reference' },
          {
            type: 'file',
            name: 'workflow-reference.pdf',
            path: filePath,
            media_type: 'application/pdf',
          },
        ],
      }), expect.any(Object))
    } finally { await manager.delete(workflow.id) }
  })

  it('rejects unsupported execution tuples before persisting a run', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRuns } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    chatRunMock.runAndWait.mockReset()
    const manager = new WorkflowManager()
    const partial = manager.create({ name: `Partial tuple ${Date.now()}`, profile: 'default', nodes: [
      { id: 'agent', type: 'agent', data: { agent: 'hermes', provider: 'custom:test', input: 'work' } },
    ], edges: [] })
    const invalidApiMode = manager.create({ name: `Invalid apiMode ${Date.now()}`, profile: 'default', nodes: [
      { id: 'agent', type: 'agent', data: { agent: 'hermes', provider: 'custom:test', model: 'model-a', apiMode: 'unsupported', input: 'work' } },
    ], edges: [] })
    try {
      await expect(manager.runNow(partial.id)).rejects.toThrow('target must set provider, model, and apiMode together')
      await expect(manager.runNow(invalidApiMode.id)).rejects.toThrow('has invalid apiMode')
      expect(listWorkflowRuns(partial.id)).toEqual([])
      expect(listWorkflowRuns(invalidApiMode.id)).toEqual([])
      expect(chatRunMock.runAndWait).not.toHaveBeenCalled()
    } finally { await manager.delete(partial.id); await manager.delete(invalidApiMode.id) }
  })

  it('defers portable skill validation until runNow and fails closed before persisting a run', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRuns } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    chatRunMock.runAndWait.mockReset()
    const manager = new WorkflowManager()
    const missingSkill = `missing-portable-skill-${Date.now()}`
    const workflow = manager.create({
      name: `Missing portable skill ${Date.now()}`,
      profile: 'default',
      nodes: [{ id: 'agent', type: 'agent', data: {
        title: 'Agent', agent: 'hermes', input: 'work', skills: [missingSkill],
      } }],
      edges: [],
    })
    try {
      await expect(manager.runNow(workflow.id)).rejects.toMatchObject({
        message: `workflow node agent requires unavailable skill: ${missingSkill}`,
        status: 409,
      })
      expect(listWorkflowRuns(workflow.id)).toEqual([])
      expect(chatRunMock.runAndWait).not.toHaveBeenCalled()
    } finally { await manager.delete(workflow.id) }
  })

  it('distinguishes pending, ready, and skipped joins without treating unresolved edges as not taken', async () => {
    const { evaluateWorkflowNodeJoin } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const taken = { status: 'taken', routeMatched: true } as const
    const notTaken = { status: 'not_taken', routeMatched: false, reason: 'route_not_matched' } as const

    expect(evaluateWorkflowNodeJoin('all', [taken, undefined])).toBe('pending')
    expect(evaluateWorkflowNodeJoin('all', [taken, taken])).toBe('ready')
    expect(evaluateWorkflowNodeJoin('all', [taken, notTaken])).toBe('skipped')
    expect(evaluateWorkflowNodeJoin('any', [taken, undefined])).toBe('ready')
    expect(evaluateWorkflowNodeJoin('any', [notTaken, undefined])).toBe('pending')
    expect(evaluateWorkflowNodeJoin('any', [notTaken, notTaken])).toBe('skipped')
    expect(evaluateWorkflowNodeJoin('all', [])).toBe('ready')
  })

  it('normalizes legacy and declarative workflow edges without changing legacy semantics', async () => {
    const { normalizeWorkflowEdge } = await import('../../packages/server/src/modules/studio/services/workflow/manager')

    expect(normalizeWorkflowEdge({ id: 'legacy', source: 'first', target: 'second' })).toEqual({
      id: 'legacy', source: 'first', target: 'second', orchestration: { route: 'success' },
    })
    expect(normalizeWorkflowEdge({ id: 'conditional', source: 'first', target: 'second', data: { orchestration: { route: 'failure', condition: { path: 'output.status', operator: 'equals', value: 'RETRY' } } } })).toEqual({
      id: 'conditional', source: 'first', target: 'second', orchestration: { route: 'failure', condition: { path: 'output.status', operator: 'equals', value: 'RETRY' } },
    })
  })

  it('normalizes bounded feedback edges with a default of three iterations', async () => {
    const { normalizeWorkflowEdge, MAX_WORKFLOW_LOOP_ITERATIONS } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    expect(normalizeWorkflowEdge({
      id: 'feedback-default', source: 'review', target: 'implement',
      data: { orchestration: { route: 'success', feedback: true } },
    })?.orchestration).toEqual({ route: 'success', feedback: { maxIterations: 3 } })
    expect(normalizeWorkflowEdge({
      id: 'feedback-custom', source: 'review', target: 'implement',
      data: { orchestration: { route: 'success', feedback: { maxIterations: 7 } } },
    })?.orchestration.feedback).toEqual({ maxIterations: 7 })
    expect(MAX_WORKFLOW_LOOP_ITERATIONS).toBeGreaterThan(7)
  })

  it('rejects unbounded or malformed feedback iteration limits', async () => {
    const { normalizeWorkflowEdge, MAX_WORKFLOW_LOOP_ITERATIONS } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    for (const maxIterations of [0, -1, 1.5, '3', MAX_WORKFLOW_LOOP_ITERATIONS + 1]) {
      expect(() => normalizeWorkflowEdge({
        id: `feedback-${maxIterations}`, source: 'review', target: 'implement',
        data: { orchestration: { route: 'success', feedback: { maxIterations } } },
      })).toThrow('has invalid feedback maxIterations')
    }
    expect(() => normalizeWorkflowEdge({
      id: 'feedback-false', source: 'review', target: 'implement',
      data: { orchestration: { route: 'success', feedback: false } },
    })).toThrow('has invalid feedback')
  })

  it('rejects malformed explicit workflow edge orchestration instead of falling back to legacy routing', async () => {
    const { normalizeWorkflowEdge } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    expect(() => normalizeWorkflowEdge({ id: 'invalid-route', source: 'first', target: 'second', data: { orchestration: { route: 'sometimes' } } })).toThrow('workflow edge invalid-route has invalid orchestration route')
    expect(() => normalizeWorkflowEdge({ id: 'missing-value', source: 'first', target: 'second', data: { orchestration: { route: 'success', condition: { path: 'output.status', operator: 'equals' } } } })).toThrow('workflow edge missing-value condition operator equals requires value')
    expect(() => normalizeWorkflowEdge({ id: 'dangerous-path', source: 'first', target: 'second', data: { orchestration: { route: 'success', condition: { path: 'output.__proto__.polluted', operator: 'exists' } } } })).toThrow('invalid condition path')
    expect(() => normalizeWorkflowEdge({ id: 'empty-segment', source: 'first', target: 'second', data: { orchestration: { route: 'success', condition: { path: 'output..status', operator: 'exists' } } } })).toThrow('invalid condition path')
  })

  it('compiles a bounded single-entry natural loop from an explicit feedback edge', async () => {
    const { compileWorkflowLoops, normalizeWorkflowEdge } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const nodes = ['entry', 'implement', 'review', 'exit']
    const edges = [
      normalizeWorkflowEdge({ id: 'entry-implement', source: 'entry', target: 'implement' })!,
      normalizeWorkflowEdge({ id: 'implement-review', source: 'implement', target: 'review' })!,
      normalizeWorkflowEdge({ id: 'review-exit', source: 'review', target: 'exit' })!,
      normalizeWorkflowEdge({ id: 'retry', source: 'review', target: 'implement', data: { orchestration: { route: 'success', feedback: { maxIterations: 5 } } } })!,
    ]
    expect(compileWorkflowLoops(nodes, edges)).toEqual([{
      id: 'loop:retry', feedbackEdgeId: 'retry', headerNodeId: 'implement', latchNodeId: 'review',
      bodyNodeIds: ['implement', 'review'], maxIterations: 5, parentLoopId: null,
    }])
  })

  it('compiles a one-node feedback connection as a bounded self loop', async () => {
    const { compileWorkflowLoops, normalizeWorkflowEdge } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const feedback = normalizeWorkflowEdge({
      id: 'review-review', source: 'review', target: 'review',
      sourceHandle: 'output', targetHandle: 'top',
      data: { orchestration: { route: 'success', feedback: { maxIterations: 3 } } },
    })!

    expect(compileWorkflowLoops(['review'], [feedback])).toEqual([{
      id: 'loop:review-review', feedbackEdgeId: 'review-review',
      headerNodeId: 'review', latchNodeId: 'review', bodyNodeIds: ['review'],
      maxIterations: 3, parentLoopId: null,
    }])
  })

  it('rejects ordinary cycles and feedback edges without a forward path', async () => {
    const { compileWorkflowLoops, normalizeWorkflowEdge } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const edge = (id: string, source: string, target: string, feedback = false) => normalizeWorkflowEdge({
      id, source, target, data: feedback ? { orchestration: { route: 'success', feedback: true } } : undefined,
    })!
    expect(() => compileWorkflowLoops(['a', 'b'], [edge('a-b', 'a', 'b'), edge('b-a', 'b', 'a')])).toThrow('workflow forward graph must be acyclic')
    expect(() => compileWorkflowLoops(['a', 'b', 'c'], [edge('a-b', 'a', 'b'), edge('retry', 'c', 'a', true)])).toThrow('feedback edge retry has no forward path from a to c')
    expect(() => compileWorkflowLoops(['entry', 'header', 'body', 'latch'], [
      edge('entry-header', 'entry', 'header'), edge('header-body', 'header', 'body'),
      edge('body-latch', 'body', 'latch'), edge('entry-body', 'entry', 'body'),
      edge('retry', 'latch', 'header', true),
    ])).toThrow('feedback edge retry does not form a single-entry natural loop')
  })

  it('assigns the nearest unique parent for laminar nested loops and allows disjoint loops', async () => {
    const { compileWorkflowLoops, normalizeWorkflowEdge } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const edge = (id: string, source: string, target: string, feedback = false) => normalizeWorkflowEdge({
      id, source, target, data: feedback ? { orchestration: { route: 'success', feedback: true } } : undefined,
    })!
    const nested = compileWorkflowLoops(['entry', 'outer-h', 'inner-h', 'inner-l', 'outer-l', 'exit'], [
      edge('entry-outer', 'entry', 'outer-h'), edge('outer-inner', 'outer-h', 'inner-h'),
      edge('inner-forward', 'inner-h', 'inner-l'), edge('inner-outer-l', 'inner-l', 'outer-l'), edge('outer-exit', 'outer-l', 'exit'),
      edge('outer-retry', 'outer-l', 'outer-h', true), edge('inner-retry', 'inner-l', 'inner-h', true),
    ])
    expect(nested.map(loop => [loop.id, loop.parentLoopId, loop.bodyNodeIds])).toEqual([
      ['loop:outer-retry', null, ['outer-h', 'inner-h', 'inner-l', 'outer-l']],
      ['loop:inner-retry', 'loop:outer-retry', ['inner-h', 'inner-l']],
    ])
    const disjoint = compileWorkflowLoops(['a', 'b', 'c', 'd'], [
      edge('a-b', 'a', 'b'), edge('c-d', 'c', 'd'), edge('left-retry', 'b', 'a', true), edge('right-retry', 'd', 'c', true),
    ])
    expect(disjoint.map(loop => loop.parentLoopId)).toEqual([null, null])
  })

  it('rejects partially overlapping loop bodies that are not laminar', async () => {
    const { validateLaminarWorkflowLoops } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    expect(() => validateLaminarWorkflowLoops([
      { id: 'loop:left', bodyNodeIds: ['a', 'shared'], parentLoopId: null },
      { id: 'loop:right', bodyNodeIds: ['shared', 'b'], parentLoopId: null },
    ] as any)).toThrow('workflow loops loop:left and loop:right partially overlap')
    expect(() => validateLaminarWorkflowLoops([
      { id: 'loop:first', bodyNodeIds: ['a', 'b'], parentLoopId: null },
      { id: 'loop:second', bodyNodeIds: ['a', 'b'], parentLoopId: null },
    ] as any)).toThrow('workflow loops loop:first and loop:second have identical bodies')
  })

  it('evaluates equals conditions through own properties only', async () => {
    const { evaluateWorkflowEdgeCondition } = await import('../../packages/server/src/modules/studio/services/workflow/manager')

    expect(evaluateWorkflowEdgeCondition(
      { path: 'output.status', operator: 'equals', value: 'RETRY' },
      { output: { status: 'RETRY' } },
    )).toEqual({ status: 'matched', actual: 'RETRY' })
    expect(evaluateWorkflowEdgeCondition(
      { path: 'output.status', operator: 'equals', value: 'RETRY' },
      { output: {} },
    )).toEqual({ status: 'not_matched', reason: 'path_not_found' })

    const inherited = Object.create({ status: 'RETRY' })
    expect(evaluateWorkflowEdgeCondition(
      { path: 'output.status', operator: 'equals', value: 'RETRY' },
      { output: inherited },
    )).toEqual({ status: 'not_matched', reason: 'path_not_found' })
  })

  it('evaluates the supported declarative condition operators without coercing missing operands', async () => {
    const { evaluateWorkflowEdgeCondition } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const evaluate = (operator: string, actual: unknown, value?: unknown) => evaluateWorkflowEdgeCondition(
      value === undefined
        ? { path: 'output.value', operator }
        : { path: 'output.value', operator, value },
      { output: { value: actual } },
    )

    expect(evaluate('not_equals', 'PASS', 'RETRY').status).toBe('matched')
    expect(evaluate('contains', 'build completed', 'complete').status).toBe('matched')
    expect(evaluate('not_contains', ['safe', 'read'], 'write').status).toBe('matched')
    expect(evaluate('greater_than', 4, 3).status).toBe('matched')
    expect(evaluate('greater_than_or_equal', 3, 3).status).toBe('matched')
    expect(evaluate('less_than', 2, 3).status).toBe('matched')
    expect(evaluate('less_than_or_equal', 3, 3).status).toBe('matched')
    expect(evaluate('in', 'PASS', ['PASS', 'BLOCKED']).status).toBe('matched')
    expect(evaluate('not_in', 'RETRY', ['PASS', 'BLOCKED']).status).toBe('matched')
    expect(evaluate('exists', null).status).toBe('matched')
    expect(evaluate('not_exists', null).status).toBe('not_matched')

    expect(() => evaluateWorkflowEdgeCondition(
      { path: 'output.value', operator: 'contains' } as any,
      { output: { value: 'anything' } },
    )).toThrow('workflow condition operator contains requires value')
    expect(evaluateWorkflowEdgeCondition(
      { path: 'output.missing', operator: 'not_exists' } as any,
      { output: {} },
    )).toEqual({ status: 'matched', reason: 'path_not_found' })
  })

  it('evaluates edge routes before conditions and returns auditable decisions', async () => {
    const { evaluateWorkflowEdgeRoute } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const context = { output: { status: 'PASS' } }
    const condition = { path: 'output.status', operator: 'equals', value: 'PASS' } as const

    expect(evaluateWorkflowEdgeRoute({ route: 'success', condition }, 'success', context)).toMatchObject({ status: 'taken', routeMatched: true, condition: { status: 'matched' } })
    expect(evaluateWorkflowEdgeRoute({ route: 'success', condition }, 'failure', context)).toEqual({ status: 'not_taken', routeMatched: false, reason: 'route_not_matched' })
    expect(evaluateWorkflowEdgeRoute({ route: 'failure' }, 'failure', context)).toEqual({ status: 'taken', routeMatched: true })
    expect(evaluateWorkflowEdgeRoute({ route: 'always' }, 'failure', context)).toEqual({ status: 'taken', routeMatched: true })
    expect(evaluateWorkflowEdgeRoute({ route: 'always', condition: { ...condition, value: 'RETRY' } }, 'success', context)).toMatchObject({ status: 'not_taken', routeMatched: true, reason: 'condition_not_matched' })
  })

  it('parses unambiguous structured assistant output without depending on JSON whitespace', async () => {
    const { parseWorkflowStructuredOutput } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const expected = { decision: 'RELEASED', route_token: 'HSR_RELEASED_OK' }

    expect(parseWorkflowStructuredOutput(JSON.stringify(expected))).toEqual(expected)
    expect(parseWorkflowStructuredOutput(JSON.stringify(expected, null, 2))).toEqual(expected)
    expect(parseWorkflowStructuredOutput(`Result:\n\n\`\`\`json\n${JSON.stringify(expected, null, 2)}\n\`\`\``)).toEqual(expected)
    expect(parseWorkflowStructuredOutput('```json\n{"decision":"A"}\n```\n```json\n{"decision":"B"}\n```')).toBeUndefined()
    expect(parseWorkflowStructuredOutput('```json\n{"decision":"A"}\n```\n```json\n{"decision":"B"')).toBeUndefined()
    expect(parseWorkflowStructuredOutput('```json\n{"decision":\n```')).toBeUndefined()
    expect(parseWorkflowStructuredOutput('not json')).toBeUndefined()
  })

  it('rejects dangerous condition paths before evaluation', async () => {
    const { evaluateWorkflowEdgeCondition } = await import('../../packages/server/src/modules/studio/services/workflow/manager')

    for (const path of ['output.__proto__.polluted', 'output.prototype.value', 'output.constructor.name']) {
      expect(() => evaluateWorkflowEdgeCondition(
        { path, operator: 'equals', value: 'anything' },
        { output: {} },
      )).toThrow(`workflow condition path contains forbidden segment: ${path}`)
    }
  })

  it('rejects invalid workflow graphs before creating a run or starting an agent', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRuns } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    const make = (name: string, edges: unknown[]) => manager.create({
      name: `Preflight ${name} ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'a', type: 'agent', data: { title: 'A', agent: 'hermes', input: 'a' } },
        { id: 'b', type: 'agent', data: { title: 'B', agent: 'hermes', input: 'b' } },
      ], edges,
    })
    const dangling = make('dangling', [{ id: 'dangling', source: 'a', target: 'missing' }])
    const cycle = make('cycle', [{ id: 'a-b', source: 'a', target: 'b' }, { id: 'b-a', source: 'b', target: 'a' }])
    try {
      await expect(manager.runNow(dangling.id)).rejects.toThrow('workflow edge dangling references missing node')
      await expect(manager.runNow(cycle.id)).rejects.toThrow('workflow forward graph must be acyclic')
      expect(listWorkflowRuns(dangling.id)).toEqual([])
      expect(listWorkflowRuns(cycle.id)).toEqual([])
      expect(chatRunMock.runAndWait).not.toHaveBeenCalled()
    } finally { await manager.delete(dangling.id); await manager.delete(cycle.id) }
  })

  it('rejects duplicate graph identities and invalid explicit start nodes during preflight', async () => {
    const { compileWorkflowGraphPreflight } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const node = (id: string) => ({ id, type: 'agent', data: { title: id, agent: 'hermes' } })
    expect(() => compileWorkflowGraphPreflight([node('a'), node('a')], [])).toThrow('workflow has duplicate node id: a')
    expect(() => compileWorkflowGraphPreflight([node('a'), node('b')], [
      { id: 'same', source: 'a', target: 'b' }, { id: 'same', source: 'a', target: 'b' },
    ])).toThrow('workflow has duplicate edge id: same')
    expect(() => compileWorkflowGraphPreflight([node('a')], [], ['missing'])).toThrow('workflow start node does not exist: missing')
    expect(() => compileWorkflowGraphPreflight([node('a'), {}], [])).toThrow('workflow node at index 1 is invalid')
    expect(() => compileWorkflowGraphPreflight([node('a')], [{}])).toThrow('workflow edge at index 0 is invalid')
    expect(compileWorkflowGraphPreflight([node('a'), node('b')], [], ['b', 'b', 'a']).startNodeIds).toEqual(['b', 'a'])
  })

  it('calculates static execution bounds for disjoint and nested loop membership', async () => {
    const { calculateWorkflowStaticExecutionBound } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const loop = (id: string, bodyNodeIds: string[], maxIterations: number) => ({ id, bodyNodeIds, maxIterations }) as any
    expect(calculateWorkflowStaticExecutionBound(['plain'], [])).toBe(1)
    expect(calculateWorkflowStaticExecutionBound(['a', 'b', 'plain'], [
      loop('left', ['a'], 3), loop('right', ['b'], 5),
    ])).toBe(9)
    expect(calculateWorkflowStaticExecutionBound(['outer-only', 'inner'], [
      loop('outer', ['outer-only', 'inner'], 3), loop('inner', ['inner'], 4),
    ])).toBe(15)
  })

  it('passes only the remaining run deadline to each loop execution', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    let now = 1000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const receivedTimeouts: Array<number | undefined> = []
    chatRunMock.runAndWait.mockReset().mockImplementation(async (_request: unknown, options: { timeoutMs?: number }) => {
      receivedTimeouts.push(options.timeoutMs)
      now += 40
      return { ok: true, output: 'continue' }
    })
    const workflow = manager.create({
      name: `Run deadline remaining ${now}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id, { timeoutMs: 100 })
      expect(result.run.status).toBe('failed')
      expect(result.run.error).toBe('workflow run timed out after 100ms')
      expect(result.run).toMatchObject({
        requested_timeout_ms: 100,
        deadline_at: 1100,
      })
      expect(receivedTimeouts).toEqual([100, 60, 20])
      expect(result.nodeSessions.map(session => [session.execution_id, session.remaining_timeout_ms_at_start])).toEqual([
        ['header@loop:retry:0', 100],
        ['latch@loop:retry:0', 60],
        ['header@loop:retry:1', 20],
      ])
      expect(result.nodeSessions.map(session => session.execution_id)).toEqual([
        'header@loop:retry:0', 'latch@loop:retry:0', 'header@loop:retry:1',
      ])
    } finally { nowSpy.mockRestore(); await manager.delete(workflow.id) }
  })

  it('bounds skill assembly by the same absolute Run deadline', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    let resolutionCount = 0
    workflowSkillResolverMock.resolve = async ({ skillName }) => {
      resolutionCount += 1
      if (resolutionCount === 1) return { name: skillName, content: 'preflight evidence' }
      return new Promise(() => {})
    }
    const workflow = manager.create({
      name: `Skill assembly deadline ${Date.now()}`,
      profile: 'default',
      nodes: [{ id: 'agent', type: 'agent', data: {
        title: 'Agent', agent: 'hermes', input: 'work', skills: ['delayed-skill'],
      } }],
      edges: [],
    })
    try {
      const result = await manager.runNow(workflow.id, { timeoutMs: 20 })
      expect(result.run.status).toBe('failed')
      expect(result.run.error).toBe('workflow run timed out after 20ms')
      expect(result.nodeSessions).toEqual([])
      expect(chatRunMock.runAndWait).not.toHaveBeenCalled()
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.agent).toBe('failed')
    } finally {
      workflowSkillResolverMock.resolve = null
      await manager.delete(workflow.id)
    }
  })

  it('fails closed when run-deadline loop epoch evidence cannot be persisted', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { getDb } = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const db = getDb()!
    db.exec(`CREATE TRIGGER fail_deadline_loop_epoch BEFORE INSERT ON workflow_run_loop_epochs
      WHEN NEW.status = 'timed_out' AND NEW.exit_reason LIKE 'workflow run timed out%'
      BEGIN SELECT RAISE(ABORT, 'run deadline epoch write failed'); END`)
    const manager = new WorkflowManager()
    let now = 2000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    chatRunMock.runAndWait.mockReset().mockImplementation(async () => { now += 60; return { ok: true, output: 'continue' } })
    const workflow = manager.create({
      name: `Deadline evidence failure ${now}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id, { timeoutMs: 100 })
      expect(result.run.status).toBe('failed')
      expect(result.run.error).toContain('run deadline epoch write failed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)
      expect(result.nodeSessions).toHaveLength(2)
    } finally {
      nowSpy.mockRestore(); db.exec('DROP TRIGGER IF EXISTS fail_deadline_loop_epoch'); await manager.delete(workflow.id)
    }
  })

  it('rejects a loop whose static execution bound exceeds the server run budget before persistence', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRuns } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { MAX_WORKFLOW_RUN_EXECUTIONS, WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    expect(MAX_WORKFLOW_RUN_EXECUTIONS).toBe(1000)
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    const nodes = Array.from({ length: 11 }, (_, index) => ({
      id: `n${index}`, type: 'agent', data: { title: `N${index}`, agent: 'hermes', input: `n${index}` },
    }))
    const edges = Array.from({ length: 10 }, (_, index) => ({ id: `e${index}`, source: `n${index}`, target: `n${index + 1}` }))
    edges.push({ id: 'retry', source: 'n10', target: 'n0', data: { orchestration: { route: 'success', feedback: { maxIterations: 100 } } } } as any)
    const workflow = manager.create({ name: `Over budget loop ${Date.now()}`, profile: 'default', nodes, edges })
    try {
      await expect(manager.runNow(workflow.id)).rejects.toThrow('workflow static execution bound 1100 exceeds run budget 1000')
      expect(listWorkflowRuns(workflow.id)).toEqual([])
      expect(chatRunMock.runAndWait).not.toHaveBeenCalled()
    } finally { await manager.delete(workflow.id) }
  })

  it('executes a bounded top-level feedback loop with distinct iteration identities', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'continue' })
    const workflow = manager.create({
      name: `Bounded loop ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ],
      edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 3 } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect({ status: result.run.status, error: result.run.error }).toEqual({ status: 'completed', error: null })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(6)
      expect(result.nodeSessions.map(session => [session.node_id, session.execution_id, session.iteration_path])).toEqual([
        ['header', 'header@loop:retry:0', [{ loopId: 'loop:retry', iteration: 0 }]],
        ['latch', 'latch@loop:retry:0', [{ loopId: 'loop:retry', iteration: 0 }]],
        ['header', 'header@loop:retry:1', [{ loopId: 'loop:retry', iteration: 1 }]],
        ['latch', 'latch@loop:retry:1', [{ loopId: 'loop:retry', iteration: 1 }]],
        ['header', 'header@loop:retry:2', [{ loopId: 'loop:retry', iteration: 2 }]],
        ['latch', 'latch@loop:retry:2', [{ loopId: 'loop:retry', iteration: 2 }]],
      ])
      const { listWorkflowRunEdgeEvaluations } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
      expect(listWorkflowRunEdgeEvaluations(result.run.id).filter(item => item.edge_id === 'retry').map(item => ({
        status: item.status, reason: item.reason, sourceExecutionId: item.source_execution_id, iterationPath: item.iteration_path,
      }))).toEqual([
        { status: 'taken', reason: null, sourceExecutionId: 'latch@loop:retry:0', iterationPath: [{ loopId: 'loop:retry', iteration: 0 }] },
        { status: 'taken', reason: null, sourceExecutionId: 'latch@loop:retry:1', iterationPath: [{ loopId: 'loop:retry', iteration: 1 }] },
        { status: 'not_taken', reason: 'iteration_limit_reached', sourceExecutionId: 'latch@loop:retry:2', iterationPath: [{ loopId: 'loop:retry', iteration: 2 }] },
      ])
      expect(listWorkflowRunEdgeEvaluations(result.run.id).filter(item => item.edge_id === 'forward').map(item => ({
        status: item.status, sourceExecutionId: item.source_execution_id, iterationPath: item.iteration_path,
      }))).toEqual([
        { status: 'taken', sourceExecutionId: 'header@loop:retry:0', iterationPath: [{ loopId: 'loop:retry', iteration: 0 }] },
        { status: 'taken', sourceExecutionId: 'header@loop:retry:1', iterationPath: [{ loopId: 'loop:retry', iteration: 1 }] },
        { status: 'taken', sourceExecutionId: 'header@loop:retry:2', iterationPath: [{ loopId: 'loop:retry', iteration: 2 }] },
      ])
      const { listWorkflowRunLoopEpochs } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
      expect(listWorkflowRunLoopEpochs(result.run.id).map(epoch => ({
        loopId: epoch.loop_id, iteration: epoch.iteration, path: epoch.iteration_path,
        status: epoch.status, exitReason: epoch.exit_reason,
      }))).toEqual([
        { loopId: 'loop:retry', iteration: 0, path: [{ loopId: 'loop:retry', iteration: 0 }], status: 'completed', exitReason: 'feedback_taken' },
        { loopId: 'loop:retry', iteration: 1, path: [{ loopId: 'loop:retry', iteration: 1 }], status: 'completed', exitReason: 'feedback_taken' },
        { loopId: 'loop:retry', iteration: 2, path: [{ loopId: 'loop:retry', iteration: 2 }], status: 'completed', exitReason: 'iteration_limit_reached' },
      ])
    } finally { await manager.delete(workflow.id) }
  })

  it('executes two disjoint bounded loops with independent canonical iteration paths', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'continue' })
    const workflow = manager.create({
      name: `Disjoint loops ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'a-header', type: 'agent', data: { title: 'A header', agent: 'hermes', input: 'a-header' } },
        { id: 'a-latch', type: 'agent', data: { title: 'A latch', agent: 'hermes', input: 'a-latch' } },
        { id: 'b-header', type: 'agent', data: { title: 'B header', agent: 'hermes', input: 'b-header' } },
        { id: 'b-latch', type: 'agent', data: { title: 'B latch', agent: 'hermes', input: 'b-latch' } },
      ], edges: [
        { id: 'a-forward', source: 'a-header', target: 'a-latch' },
        { id: 'a-retry', source: 'a-latch', target: 'a-header', data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } } },
        { id: 'b-forward', source: 'b-header', target: 'b-latch' },
        { id: 'b-retry', source: 'b-latch', target: 'b-header', data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('completed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(8)
      expect(result.nodeSessions.map(session => [session.node_id, session.iteration_path])
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))).toEqual([
        ['a-header', [{ loopId: 'loop:a-retry', iteration: 0 }]],
        ['a-header', [{ loopId: 'loop:a-retry', iteration: 1 }]],
        ['a-latch', [{ loopId: 'loop:a-retry', iteration: 0 }]],
        ['a-latch', [{ loopId: 'loop:a-retry', iteration: 1 }]],
        ['b-header', [{ loopId: 'loop:b-retry', iteration: 0 }]],
        ['b-header', [{ loopId: 'loop:b-retry', iteration: 1 }]],
        ['b-latch', [{ loopId: 'loop:b-retry', iteration: 0 }]],
        ['b-latch', [{ loopId: 'loop:b-retry', iteration: 1 }]],
      ])
    } finally { await manager.delete(workflow.id) }
  })

  it('executes a strictly nested loop inner-first with canonical nested iteration paths', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'continue' })
    const workflow = manager.create({
      name: `Nested loops ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'outer-header', type: 'agent', data: { title: 'Outer header', agent: 'hermes', input: 'outer-header' } },
        { id: 'inner-header', type: 'agent', data: { title: 'Inner header', agent: 'hermes', input: 'inner-header' } },
        { id: 'inner-latch', type: 'agent', data: { title: 'Inner latch', agent: 'hermes', input: 'inner-latch' } },
        { id: 'outer-latch', type: 'agent', data: { title: 'Outer latch', agent: 'hermes', input: 'outer-latch' } },
      ], edges: [
        { id: 'enter-inner', source: 'outer-header', target: 'inner-header' },
        { id: 'inner-forward', source: 'inner-header', target: 'inner-latch' },
        { id: 'leave-inner', source: 'inner-latch', target: 'outer-latch' },
        { id: 'inner-retry', source: 'inner-latch', target: 'inner-header', data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } } },
        { id: 'outer-retry', source: 'outer-latch', target: 'outer-header', data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('completed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(12)
      expect(result.nodeSessions.map(session => [session.node_id, session.iteration_path])).toEqual([
        ['outer-header', [{ loopId: 'loop:outer-retry', iteration: 0 }]],
        ['inner-header', [{ loopId: 'loop:outer-retry', iteration: 0 }, { loopId: 'loop:inner-retry', iteration: 0 }]],
        ['inner-latch', [{ loopId: 'loop:outer-retry', iteration: 0 }, { loopId: 'loop:inner-retry', iteration: 0 }]],
        ['inner-header', [{ loopId: 'loop:outer-retry', iteration: 0 }, { loopId: 'loop:inner-retry', iteration: 1 }]],
        ['inner-latch', [{ loopId: 'loop:outer-retry', iteration: 0 }, { loopId: 'loop:inner-retry', iteration: 1 }]],
        ['outer-latch', [{ loopId: 'loop:outer-retry', iteration: 0 }]],
        ['outer-header', [{ loopId: 'loop:outer-retry', iteration: 1 }]],
        ['inner-header', [{ loopId: 'loop:outer-retry', iteration: 1 }, { loopId: 'loop:inner-retry', iteration: 0 }]],
        ['inner-latch', [{ loopId: 'loop:outer-retry', iteration: 1 }, { loopId: 'loop:inner-retry', iteration: 0 }]],
        ['inner-header', [{ loopId: 'loop:outer-retry', iteration: 1 }, { loopId: 'loop:inner-retry', iteration: 1 }]],
        ['inner-latch', [{ loopId: 'loop:outer-retry', iteration: 1 }, { loopId: 'loop:inner-retry', iteration: 1 }]],
        ['outer-latch', [{ loopId: 'loop:outer-retry', iteration: 1 }]],
      ])
    } finally { await manager.delete(workflow.id) }
  })

  it('executes arbitrary-depth nested loops inside a broader DAG with canonical paths', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'continue' })
    const agent = (id: string) => ({ id, type: 'agent', data: { title: id, agent: 'hermes', input: id } })
    const feedback = (id: string, source: string, target: string) => ({
      id, source, target, data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } },
    })
    const workflow = manager.create({
      name: `Deep nested loops ${Date.now()}`, profile: 'default',
      nodes: ['pre', 'outer-h', 'middle-h', 'inner-h', 'inner-l', 'middle-l', 'outer-l', 'post'].map(agent),
      edges: [
        { id: 'pre-outer', source: 'pre', target: 'outer-h' },
        { id: 'outer-middle', source: 'outer-h', target: 'middle-h' },
        { id: 'middle-inner', source: 'middle-h', target: 'inner-h' },
        { id: 'inner-forward', source: 'inner-h', target: 'inner-l' },
        { id: 'inner-middle', source: 'inner-l', target: 'middle-l' },
        { id: 'middle-outer', source: 'middle-l', target: 'outer-l' },
        { id: 'outer-post', source: 'outer-l', target: 'post' },
        feedback('inner-retry', 'inner-l', 'inner-h'),
        feedback('middle-retry', 'middle-l', 'middle-h'),
        feedback('outer-retry', 'outer-l', 'outer-h'),
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('completed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(30)
      const innerSessions = result.nodeSessions.filter(session => session.node_id === 'inner-h')
      expect(innerSessions).toHaveLength(8)
      expect(innerSessions.at(-1)?.iteration_path).toEqual([
        { loopId: 'loop:outer-retry', iteration: 1 },
        { loopId: 'loop:middle-retry', iteration: 1 },
        { loopId: 'loop:inner-retry', iteration: 1 },
      ])
      expect(result.nodeSessions.find(session => session.node_id === 'pre')?.iteration_path).toEqual([])
      expect(result.nodeSessions.find(session => session.node_id === 'post')?.iteration_path).toEqual([])
    } finally { await manager.delete(workflow.id) }
  })

  it('skips an unmatched conditional node inside a loop iteration without creating a session', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRunEdgeEvaluations } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockImplementation(async (request: { session_id: string; input: string }) => {
      const output = request.input.includes('header') ? 'use-required' : request.input.includes('required') ? 'required-ok' : 'latch-ok'
      chatRunMock.sessionOutputs.set(request.session_id, output)
      return { ok: true, output }
    })
    const workflow = manager.create({
      name: `Conditional loop body ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'required', type: 'agent', data: { title: 'Required', agent: 'hermes', input: 'required' } },
        { id: 'optional', type: 'agent', data: { title: 'Optional', agent: 'hermes', input: 'optional' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch', orchestration: { join: 'any' } } },
      ], edges: [
        { id: 'header-required', source: 'header', target: 'required' },
        { id: 'header-optional', source: 'header', target: 'optional', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'equals', value: 'use-optional' } } } },
        { id: 'required-latch', source: 'required', target: 'latch' },
        { id: 'optional-latch', source: 'optional', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 1 } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('completed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(3)
      expect(result.nodeSessions.map(session => session.node_id)).toEqual(['header', 'required', 'latch'])
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.optional).toBe('skipped')
      expect(listWorkflowRunEdgeEvaluations(result.run.id).filter(item => ['header-optional', 'optional-latch'].includes(item.edge_id)).map(item => [item.edge_id, item.source_outcome, item.status])).toEqual([
        ['header-optional', 'success', 'not_taken'],
        ['optional-latch', 'skipped', 'not_taken'],
      ])
    } finally { await manager.delete(workflow.id) }
  })

  it('retries an iteration when an earlier loop node fails and the failure feedback source is skipped', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRunEdgeEvaluations } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
      .mockResolvedValueOnce({ ok: false, error: 'header retryable failure' })
      .mockResolvedValueOnce({ ok: true, output: 'header recovered' })
      .mockResolvedValueOnce({ ok: true, output: 'latch recovered' })
    const workflow = manager.create({
      name: `Early failure feedback recovery ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'failure', feedback: { maxIterations: 2 } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('completed')
      expect(result.nodeSessions.map(session => [session.execution_id, session.status])).toEqual([
        ['header@loop:retry:0', 'failed'],
        ['header@loop:retry:1', 'completed'],
        ['latch@loop:retry:1', 'completed'],
      ])
      expect(listWorkflowRunEdgeEvaluations(result.run.id).filter(item => item.edge_id === 'retry').map(item => [item.source_outcome, item.status])).toEqual([
        ['failure', 'taken'], ['success', 'not_taken'],
      ])
    } finally { await manager.delete(workflow.id) }
  })

  it.each(['failure', 'always'] as const)('retries a failed loop iteration through a %s feedback route and completes after recovery', async (route) => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRunEdgeEvaluations, listWorkflowRunLoopEpochs } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
      .mockResolvedValueOnce({ ok: true, output: 'header first' })
      .mockResolvedValueOnce({ ok: false, error: 'retryable failure' })
      .mockResolvedValueOnce({ ok: true, output: 'header recovered' })
      .mockResolvedValueOnce({ ok: true, output: 'latch recovered' })
    const workflow = manager.create({
      name: `${route} feedback recovery ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route, feedback: { maxIterations: 2 } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect({ status: result.run.status, error: result.run.error }).toEqual({ status: 'completed', error: null })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(4)
      expect(result.nodeSessions.map(session => [session.execution_id, session.status])).toEqual([
        ['header@loop:retry:0', 'completed'],
        ['latch@loop:retry:0', 'failed'],
        ['header@loop:retry:1', 'completed'],
        ['latch@loop:retry:1', 'completed'],
      ])
      expect(listWorkflowRunEdgeEvaluations(result.run.id).filter(item => item.edge_id === 'retry').map(item => ({
        outcome: item.source_outcome, status: item.status, reason: item.reason,
      }))).toEqual([
        { outcome: 'failure', status: 'taken', reason: null },
        { outcome: 'success', status: 'not_taken', reason: route === 'always' ? 'iteration_limit_reached' : 'route_not_matched' },
      ])
      expect(listWorkflowRunLoopEpochs(result.run.id).map(epoch => [epoch.status, epoch.exit_reason])).toEqual([
        ['failed', 'retryable failure'],
        ['completed', route === 'always' ? 'iteration_limit_reached' : 'route_not_matched'],
      ])
    } finally { await manager.delete(workflow.id) }
  })

  it.each(['hermes', 'claude-code'] as const)('persists a resolvable Session before a failing %s workflow node can leave evidence', async (agent) => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { getDb } = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: false, error: 'runner failed before session creation' })
    const workspace = join(workflowManagerTestDbDir, `workflow-session-${agent}`)
    const workflow = manager.create({
      name: `Resolvable ${agent} session ${Date.now()}`, profile: 'default', workspace,
      nodes: [{ id: 'node', type: 'agent', data: {
        title: 'Node', agent, provider: 'custom:test', model: 'model-a', apiMode: 'chat_completions', input: 'work',
      } }], edges: [],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('failed')
      const nodeSession = result.nodeSessions[0]
      expect(nodeSession.status).toBe('failed')
      expect(getDb()!.prepare(`SELECT id, profile, source, agent, workspace FROM sessions WHERE id = ?`).get(nodeSession.session_id)).toEqual({
        id: nodeSession.session_id,
        profile: 'default',
        source: 'workflow',
        agent: agent === 'hermes' ? 'hermes' : 'claude',
        workspace,
      })
    } finally { await manager.delete(workflow.id) }
  })

  it('records a failed loop epoch when an agent fails during an iteration', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRunLoopEpochs } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
      .mockResolvedValueOnce({ ok: true, output: 'header ok' })
      .mockResolvedValueOnce({ ok: false, error: 'latch exploded' })
    const workflow = manager.create({
      name: `Failed loop epoch ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 3 } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect({ status: result.run.status, error: result.run.error }).toEqual({ status: 'failed', error: 'latch exploded' })
      expect(result.nodeSessions.map(session => [session.execution_id, session.status, session.error])).toEqual([
        ['header@loop:retry:0', 'completed', null],
        ['latch@loop:retry:0', 'failed', 'latch exploded'],
      ])
      expect(listWorkflowRunLoopEpochs(result.run.id).map(epoch => ({
        iteration: epoch.iteration, path: epoch.iteration_path, status: epoch.status, exitReason: epoch.exit_reason,
      }))).toEqual([{ iteration: 0, path: [{ loopId: 'loop:retry', iteration: 0 }], status: 'failed', exitReason: 'latch exploded' }])
    } finally { await manager.delete(workflow.id) }
  })

  it('keys simultaneous nested approvals by execution instance', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'review' })
    const workflow = manager.create({
      name: `Execution approvals ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header', approvalRequired: true } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } } },
      ],
    })
    try {
      const runPromise = manager.runNow(workflow.id)
      await vi.waitFor(() => expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.header).toBe('pending_approval'))
      expect(manager.getRuntimeStatus(workflow.id).pendingApprovals).toEqual([
        { nodeId: 'header', executionId: 'header@loop:retry:0' },
      ])
      const runId = manager.getRuntimeStatus(workflow.id).runId!
      expect(manager.approveNode(workflow.id, runId, 'header', true, 'header@loop:retry:0')).toBe(true)
      await vi.waitFor(() => expect(manager.getRuntimeStatus(workflow.id).pendingApprovals).toEqual([
        { nodeId: 'header', executionId: 'header@loop:retry:1' },
      ]))
      expect(manager.approveNode(workflow.id, runId, 'header', true, 'header@loop:retry:1')).toBe(true)
      expect((await runPromise).run.status).toBe('completed')
    } finally { await manager.delete(workflow.id) }
  })

  it('atomically rejects simultaneous runs of the same workflow before either can overwrite approval status', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listActiveWorkflowRuns } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'review' })
    const workflow = manager.create({
      name: `Concurrent approval ${Date.now()}`, profile: 'default',
      nodes: [{ id: 'review', type: 'agent', data: { title: 'Review', agent: 'hermes', input: 'review', approvalRequired: true } }],
      edges: [],
    })
    try {
      const attempts = [manager.runNow(workflow.id), manager.runNow(workflow.id)]
      const observed = attempts.map(attempt => attempt.then(
        value => ({ status: 'fulfilled' as const, value }),
        reason => ({ status: 'rejected' as const, reason }),
      ))
      await vi.waitFor(() => expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.review).toBe('pending_approval'))
      const firstRunId = manager.getRuntimeStatus(workflow.id).runId!
      const rejected = await Promise.race(observed.map(async attempt => {
        const result = await attempt
        return result.status === 'rejected' ? result.reason : null
      }))

      expect(rejected).toMatchObject({ message: 'workflow is already running', status: 409 })
      expect(listActiveWorkflowRuns().filter(run => run.workflow_id === workflow.id)).toHaveLength(1)
      expect(manager.getRuntimeStatus(workflow.id)).toMatchObject({
        runId: firstRunId,
        nodeStatuses: { review: 'pending_approval' },
        pendingApprovals: [{ nodeId: 'review', executionId: 'review' }],
      })

      expect(manager.approveNode(workflow.id, firstRunId, 'review', true, 'review')).toBe(true)
      const settled = await Promise.allSettled(attempts)
      expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(settled.filter(result => result.status === 'rejected')).toHaveLength(1)
    } finally { await manager.delete(workflow.id) }
  })

  it('times out and removes a pending loop approval at the run deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRunLoopEpochs } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'review me' })
    const workflow = manager.create({
      name: 'Approval deadline loop', profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header', approvalRequired: true } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } } },
      ],
    })
    try {
      const runPromise = manager.runNow(workflow.id, { timeoutMs: 100 })
      await vi.advanceTimersByTimeAsync(0)
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.header).toBe('pending_approval')
      await vi.advanceTimersByTimeAsync(100)
      const result = await runPromise
      expect({ status: result.run.status, error: result.run.error }).toEqual({ status: 'failed', error: 'workflow run timed out after 100ms' })
      expect(result.nodeSessions.map(session => [session.status, session.error])).toEqual([['failed', 'workflow run timed out after 100ms']])
      expect(listWorkflowRunLoopEpochs(result.run.id).map(epoch => [epoch.status, epoch.exit_reason])).toEqual([
        ['timed_out', 'workflow run timed out after 100ms'],
      ])
      expect(manager.approveNode(workflow.id, result.run.id, 'header', true)).toBe(false)
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      await manager.delete(workflow.id)
    }
  })

  it('fails closed when approval-deadline loop epoch evidence cannot be persisted', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(3000)
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { getDb } = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const db = getDb()!
    db.exec(`CREATE TRIGGER fail_approval_deadline_epoch BEFORE INSERT ON workflow_run_loop_epochs
      WHEN NEW.status = 'timed_out' AND NEW.exit_reason = 'workflow run timed out after 100ms'
      BEGIN SELECT RAISE(ABORT, 'approval deadline epoch write failed'); END`)
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'review me' })
    const workflow = manager.create({
      name: 'Approval deadline evidence', profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header', approvalRequired: true } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } } },
      ],
    })
    try {
      const runPromise = manager.runNow(workflow.id, { timeoutMs: 100 })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(100)
      const result = await runPromise
      expect(result.run.status).toBe('failed')
      expect(result.run.error).toContain('approval deadline epoch write failed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
      expect(manager.approveNode(workflow.id, result.run.id, 'header', true)).toBe(false)
    } finally {
      vi.useRealTimers()
      db.exec('DROP TRIGGER IF EXISTS fail_approval_deadline_epoch')
      await manager.delete(workflow.id)
    }
  })

  it('records an approval_rejected loop epoch and stops the iteration', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRunLoopEpochs } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'needs review' })
    const workflow = manager.create({
      name: `Rejected loop approval ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header', approvalRequired: true } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 3 } } } },
      ],
    })
    try {
      const runPromise = manager.runNow(workflow.id)
      await vi.waitFor(() => expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.header).toBe('pending_approval'))
      const runId = manager.getRuntimeStatus(workflow.id).runId!
      expect(manager.approveNode(workflow.id, runId, 'header', false)).toBe(true)
      const result = await runPromise
      expect({ status: result.run.status, error: result.run.error }).toEqual({ status: 'failed', error: 'Workflow node approval rejected' })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
      expect(result.nodeSessions.map(session => [session.execution_id, session.status, session.error])).toEqual([
        ['header@loop:retry:0', 'approval_rejected', 'Workflow node approval rejected'],
      ])
      expect(listWorkflowRunLoopEpochs(result.run.id).map(epoch => ({ status: epoch.status, exitReason: epoch.exit_reason }))).toEqual([
        { status: 'approval_rejected', exitReason: 'Workflow node approval rejected' },
      ])
    } finally { await manager.delete(workflow.id) }
  })

  it('fails closed when approval_rejected loop epoch evidence cannot be persisted', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { getDb } = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const db = getDb()!
    db.exec(`CREATE TRIGGER fail_rejected_loop_epoch BEFORE INSERT ON workflow_run_loop_epochs
      WHEN NEW.status = 'approval_rejected' BEGIN SELECT RAISE(ABORT, 'rejected loop epoch write failed'); END`)
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'review' })
    const workflow = manager.create({
      name: `Rejected epoch persistence ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header', approvalRequired: true } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } } },
      ],
    })
    try {
      const runPromise = manager.runNow(workflow.id)
      await vi.waitFor(() => expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.header).toBe('pending_approval'))
      const runId = manager.getRuntimeStatus(workflow.id).runId!
      expect(manager.approveNode(workflow.id, runId, 'header', false)).toBe(true)
      const result = await runPromise
      expect(result.run.status).toBe('failed')
      expect(result.run.error).toContain('rejected loop epoch write failed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_rejected_loop_epoch')
      await manager.delete(workflow.id)
    }
  })

  it('requires a fresh approval for each loop execution instance', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'continue' })
    const workflow = manager.create({
      name: `Approved loop executions ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header', approvalRequired: true } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } } },
      ],
    })
    try {
      const runPromise = manager.runNow(workflow.id)
      await vi.waitFor(() => expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.header).toBe('pending_approval'))
      const runId = manager.getRuntimeStatus(workflow.id).runId!
      expect(manager.approveNode(workflow.id, runId, 'header', true)).toBe(true)
      await vi.waitFor(() => expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(3))
      await vi.waitFor(() => expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.header).toBe('pending_approval'))
      expect(manager.approveNode(workflow.id, runId, 'header', true)).toBe(true)
      const result = await runPromise
      expect(result.run.status).toBe('completed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(4)
      expect(result.nodeSessions.filter(session => session.node_id === 'header').map(session => session.status)).toEqual(['completed', 'completed'])
    } finally { await manager.delete(workflow.id) }
  })

  it('records a timed_out loop epoch for the runAndWait timeout contract', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRunLoopEpochs } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    let actualTimeoutMs: number | undefined
    chatRunMock.runAndWait.mockReset().mockImplementation(async (_request: unknown, options: { timeoutMs?: number }) => {
      actualTimeoutMs = options.timeoutMs
      return { ok: false, error: `chat-run timed out after ${options.timeoutMs}ms` }
    })
    const workflow = manager.create({
      name: `Timed out loop epoch ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 3 } } } },
      ],
    })
    // Exercise the mocked chat-run timeout, not a wall-clock deadline during setup.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    try {
      const result = await manager.runNow(workflow.id, { timeoutMs: 25 })
      expect(actualTimeoutMs).toBe(25)
      const timeoutError = `chat-run timed out after ${actualTimeoutMs}ms`
      expect({ status: result.run.status, error: result.run.error }).toEqual({ status: 'failed', error: timeoutError })
      expect(result.nodeSessions.map(session => [session.execution_id, session.status, session.error])).toEqual([
        ['header@loop:retry:0', 'failed', timeoutError],
      ])
      expect(listWorkflowRunLoopEpochs(result.run.id).map(epoch => ({ status: epoch.status, exitReason: epoch.exit_reason }))).toEqual([
        { status: 'timed_out', exitReason: timeoutError },
      ])
    } finally {
      nowSpy.mockRestore()
      await manager.delete(workflow.id)
    }
  })

  it('fails closed when timed_out loop epoch evidence cannot be persisted', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { getDb } = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const db = getDb()!
    db.exec(`CREATE TRIGGER fail_timed_out_loop_epoch BEFORE INSERT ON workflow_run_loop_epochs
      WHEN NEW.status = 'timed_out' BEGIN SELECT RAISE(ABORT, 'timed out loop epoch write failed'); END`)
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockImplementation(async (_request: unknown, options: { timeoutMs?: number }) => ({
      ok: false, error: `chat-run timed out after ${options.timeoutMs}ms`,
    }))
    const workflow = manager.create({
      name: `Timed out epoch persistence ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 3 } } } },
      ],
    })
    // Keep setup time from expiring the run before runAndWait returns its timeout.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    try {
      const result = await manager.runNow(workflow.id, { timeoutMs: 25 })
      expect(result.run.status).toBe('failed')
      expect(result.run.error).toContain('timed out loop epoch write failed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
    } finally {
      nowSpy.mockRestore()
      db.exec('DROP TRIGGER IF EXISTS fail_timed_out_loop_epoch')
      await manager.delete(workflow.id)
    }
  })

  it('records a canceled loop epoch without letting an aborted agent overwrite canceled state', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRuns, listWorkflowRunLoopEpochs } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    let release!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    const releasePromise = new Promise<void>(resolve => { release = resolve })
    chatRunMock.runAndWait.mockReset().mockImplementation(async () => {
      entered()
      await releasePromise
      return { ok: false, error: 'Workflow run canceled' }
    })
    const workflow = manager.create({
      name: `Canceled loop epoch ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 3 } } } },
      ],
    })
    try {
      const runPromise = manager.runNow(workflow.id)
      await enteredPromise
      const running = listWorkflowRuns(workflow.id)[0]
      await manager.stopRun(workflow.id, running.id, 'operator canceled loop')
      release()
      const result = await runPromise
      expect({ status: result.run.status, error: result.run.error }).toEqual({ status: 'canceled', error: 'operator canceled loop' })
      expect(result.nodeSessions.map(session => [session.execution_id, session.status, session.error])).toEqual([
        ['header@loop:retry:0', 'canceled', 'operator canceled loop'],
      ])
      expect(listWorkflowRunLoopEpochs(result.run.id).map(epoch => ({
        iteration: epoch.iteration, status: epoch.status, exitReason: epoch.exit_reason,
      }))).toEqual([{ iteration: 0, status: 'canceled', exitReason: 'operator canceled loop' }])
    } finally { release(); await manager.delete(workflow.id) }
  })

  it('fails closed when canceled loop epoch evidence cannot be persisted', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { getDb } = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
    const { listWorkflowRuns } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const db = getDb()!
    db.exec(`CREATE TRIGGER fail_canceled_loop_epoch BEFORE INSERT ON workflow_run_loop_epochs
      WHEN NEW.status = 'canceled' BEGIN SELECT RAISE(ABORT, 'canceled loop epoch write failed'); END`)
    const manager = new WorkflowManager()
    let release!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    const releasePromise = new Promise<void>(resolve => { release = resolve })
    chatRunMock.runAndWait.mockReset().mockImplementation(async () => {
      entered(); await releasePromise; return { ok: false, error: 'Workflow run canceled' }
    })
    const workflow = manager.create({
      name: `Canceled epoch persistence ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 3 } } } },
      ],
    })
    try {
      const runPromise = manager.runNow(workflow.id)
      await enteredPromise
      const running = listWorkflowRuns(workflow.id)[0]
      await manager.stopRun(workflow.id, running.id, 'operator canceled loop')
      release()
      const result = await runPromise
      expect(result.run.status).toBe('failed')
      expect(result.run.error).toContain('canceled loop epoch write failed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
    } finally {
      release(); db.exec('DROP TRIGGER IF EXISTS fail_canceled_loop_epoch'); await manager.delete(workflow.id)
    }
  })

  it('fails closed when failed loop epoch evidence cannot be persisted', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { getDb } = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const db = getDb()!
    db.exec(`CREATE TRIGGER fail_failed_loop_epoch BEFORE INSERT ON workflow_run_loop_epochs
      WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'failed loop epoch write failed'); END`)
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: false, error: 'agent exploded' })
    const workflow = manager.create({
      name: `Failed epoch persistence ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 3 } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('failed')
      expect(result.run.error).toContain('failed loop epoch write failed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
      expect(result.nodeSessions.map(session => [session.execution_id, session.status])).toEqual([['header@loop:retry:0', 'failed']])
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_failed_loop_epoch')
      await manager.delete(workflow.id)
    }
  })

  it('does not start the next iteration when loop epoch evidence cannot be persisted', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { getDb } = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const db = getDb()!
    db.exec(`CREATE TRIGGER fail_loop_epoch_evidence BEFORE INSERT ON workflow_run_loop_epochs
      BEGIN SELECT RAISE(ABORT, 'loop epoch evidence write failed'); END`)
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'continue' })
    const workflow = manager.create({
      name: `Loop epoch failure ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('failed')
      expect(result.run.error).toContain('loop epoch evidence write failed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)
      expect(result.nodeSessions.map(session => session.execution_id)).toEqual(['header@loop:retry:0', 'latch@loop:retry:0'])
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_loop_epoch_evidence')
      await manager.delete(workflow.id)
    }
  })

  it('does not start a loop target when forward edge evidence cannot be persisted', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { getDb } = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const db = getDb()!
    db.exec(`CREATE TRIGGER fail_loop_forward_evidence BEFORE INSERT ON workflow_run_edge_evaluations
      WHEN NEW.edge_id = 'forward' BEGIN SELECT RAISE(ABORT, 'loop forward evidence write failed'); END`)
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'continue' })
    const workflow = manager.create({
      name: `Loop forward evidence failure ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 1 } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('failed')
      expect(result.run.error).toContain('loop forward evidence write failed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
      expect(result.nodeSessions.map(session => session.node_id)).toEqual(['header'])
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_loop_forward_evidence')
      await manager.delete(workflow.id)
    }
  })

  it('fails a loop run when its iteration-limit evidence cannot be persisted', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { getDb } = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const db = getDb()!
    db.exec(`CREATE TRIGGER fail_loop_limit_evidence BEFORE INSERT ON workflow_run_edge_evaluations
      WHEN NEW.reason = 'iteration_limit_reached' BEGIN SELECT RAISE(ABORT, 'loop limit evidence write failed'); END`)
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'continue' })
    const workflow = manager.create({
      name: `Loop evidence failure ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ],
      edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 1 } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('failed')
      expect(result.run.error).toContain('loop limit evidence write failed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_loop_limit_evidence')
      await manager.delete(workflow.id)
    }
  })

  it('executes an id-less feedback edge with the same canonical identity used by compilation', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRunEdgeEvaluations } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'continue' })
    const workflow = manager.create({
      name: `Id-less feedback ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ],
      edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('completed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(4)
      expect(listWorkflowRunEdgeEvaluations(result.run.id).filter(item => item.edge_id === 'latch->header').map(item => item.status)).toEqual(['taken', 'not_taken'])
    } finally { await manager.delete(workflow.id) }
  })

  it('applies the run input override only to the first loop iteration and then consumes feedback output', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    const inputs: string[] = []
    let call = 0
    chatRunMock.runAndWait.mockReset().mockImplementation(async (request: { session_id: string; input: string }) => {
      inputs.push(request.input)
      call += 1
      const output = call === 2 ? 'feedback-output' : `output-${call}`
      chatRunMock.sessionOutputs.set(request.session_id, output)
      return { ok: true, output }
    })
    const workflow = manager.create({
      name: `One-shot loop override ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'definition-input' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ],
      edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id, { input: 'run-override' })
      expect(result.run.status).toBe('completed')
      expect(inputs[0]).toContain('run-override')
      expect(inputs[2]).toContain('feedback-output')
      expect(inputs[2]).toContain('definition-input')
      expect(inputs[2]).not.toContain('run-override')
    } finally { await manager.delete(workflow.id) }
  })

  it('exits a top-level loop when its feedback condition is not taken and records each decision', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const { listWorkflowRunEdgeEvaluations } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    const outputs = ['header', 'continue', 'header', 'stop']
    chatRunMock.sessionOutputs.clear()
    chatRunMock.runAndWait.mockImplementation(async (request: { session_id: string }) => {
      const output = outputs.shift() || 'unexpected'
      chatRunMock.sessionOutputs.set(request.session_id, output)
      return { ok: true, output }
    })
    const workflow = manager.create({
      name: `Conditional loop exit ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ],
      edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: {
          route: 'success', feedback: { maxIterations: 3 },
          condition: { path: 'output', operator: 'equals', value: 'continue' },
        } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect({ status: result.run.status, error: result.run.error }).toEqual({ status: 'completed', error: null })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(4)
      expect(result.nodeSessions.map(session => session.execution_id)).toEqual([
        'header@loop:retry:0', 'latch@loop:retry:0', 'header@loop:retry:1', 'latch@loop:retry:1',
      ])
      expect(listWorkflowRunEdgeEvaluations(result.run.id).filter(item => item.edge_id === 'retry').map(item => ({
        status: item.status, reason: item.reason, condition: item.condition_evaluation,
      }))).toEqual([
        { status: 'taken', reason: null, condition: { status: 'matched', actual: 'continue' } },
        { status: 'not_taken', reason: 'condition_not_matched', condition: { status: 'not_matched', actual: 'stop', reason: 'not_equal' } },
      ])
    } finally { await manager.delete(workflow.id) }
  })

  it('evaluates structured JSON fields on feedback edges in the recursive scheduler', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const { listWorkflowRunEdgeEvaluations } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    const outputs = [
      'header', JSON.stringify({ action: 'continue' }, null, 2),
      'header', JSON.stringify({ action: 'stop' }, null, 2),
    ]
    chatRunMock.sessionOutputs.clear()
    chatRunMock.runAndWait.mockImplementation(async (request: { session_id: string }) => {
      const output = outputs.shift() || 'unexpected'
      chatRunMock.sessionOutputs.set(request.session_id, output)
      return { ok: true, output }
    })
    const workflow = manager.create({
      name: `Structured feedback ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ],
      edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: {
          route: 'success', feedback: { maxIterations: 3 },
          condition: { path: 'outputJson.action', operator: 'equals', value: 'continue' },
        } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('completed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(4)
      expect(listWorkflowRunEdgeEvaluations(result.run.id).filter(item => item.edge_id === 'retry').map(item => ({
        status: item.status, condition: item.condition_evaluation,
      }))).toEqual([
        { status: 'taken', condition: { status: 'matched', actual: 'continue' } },
        { status: 'not_taken', condition: { status: 'not_matched', actual: 'stop', reason: 'not_equal' } },
      ])
    } finally { await manager.delete(workflow.id) }
  })

  it('executes one downstream node after a top-level loop exits', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const { listWorkflowRunEdgeEvaluations } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.sessionOutputs.clear()
    const outputs = ['header-0', 'continue', 'header-1', 'stop', 'exit-done']
    const requests: Array<{ input: string }> = []
    chatRunMock.runAndWait.mockImplementation(async (request: { session_id: string; input: string }) => {
      requests.push({ input: request.input })
      const output = outputs.shift() || 'unexpected'
      chatRunMock.sessionOutputs.set(request.session_id, output)
      return { ok: true, output }
    })
    const workflow = manager.create({
      name: `Loop downstream ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
        { id: 'exit', type: 'agent', data: { title: 'Exit', agent: 'hermes', input: 'exit' } },
      ],
      edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: {
          route: 'success', feedback: { maxIterations: 3 },
          condition: { path: 'output', operator: 'equals', value: 'continue' },
        } } },
        { id: 'after-loop', source: 'latch', target: 'exit', data: { orchestration: {
          route: 'success', condition: { path: 'output', operator: 'equals', value: 'stop' },
        } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect({ status: result.run.status, error: result.run.error }).toEqual({ status: 'completed', error: null })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(5)
      expect(result.nodeSessions.map(session => [session.node_id, session.execution_id])).toEqual([
        ['header', 'header@loop:retry:0'], ['latch', 'latch@loop:retry:0'],
        ['header', 'header@loop:retry:1'], ['latch', 'latch@loop:retry:1'], ['exit', 'exit'],
      ])
      expect(requests[4].input).toContain('stop')
      expect(listWorkflowRunEdgeEvaluations(result.run.id).filter(item => item.edge_id === 'after-loop').map(item => ({
        status: item.status, sourceExecutionId: item.source_execution_id, iterationPath: item.iteration_path,
      }))).toEqual([
        { status: 'not_taken', sourceExecutionId: 'latch@loop:retry:0', iterationPath: [{ loopId: 'loop:retry', iteration: 0 }] },
        { status: 'taken', sourceExecutionId: 'latch@loop:retry:1', iterationPath: [{ loopId: 'loop:retry', iteration: 1 }] },
      ])
    } finally { await manager.delete(workflow.id) }
  })

  it('continues through a post-loop DAG after the final persisted exit decision', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockImplementation(async (request: { session_id: string; input: string }) => {
      const output = request.input.includes('latch') ? 'exit' : request.input.includes('first-after') ? 'first-ok' : request.input.includes('second-after') ? 'second-ok' : 'header-ok'
      chatRunMock.sessionOutputs.set(request.session_id, output)
      return { ok: true, output }
    })
    const workflow = manager.create({
      name: `Post-loop DAG ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
        { id: 'first-after', type: 'agent', data: { title: 'First after', agent: 'hermes', input: 'first-after' } },
        { id: 'second-after', type: 'agent', data: { title: 'Second after', agent: 'hermes', input: 'second-after' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 2 }, condition: { path: 'output', operator: 'equals', value: 'retry' } } } },
        { id: 'exit', source: 'latch', target: 'first-after', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'equals', value: 'exit' } } } },
        { id: 'after-forward', source: 'first-after', target: 'second-after' },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect({ status: result.run.status, error: result.run.error }).toEqual({ status: 'completed', error: null })
      expect(result.nodeSessions.map(session => session.node_id)).toEqual(['header', 'latch', 'first-after', 'second-after'])
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(4)
    } finally { await manager.delete(workflow.id) }
  })

  it('routes a failed post-loop node through failure and always edges', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockImplementation(async (request: { session_id: string; input: string }) => {
      if (request.input.includes('fails-after')) return { ok: false, error: 'post-loop boom' }
      const output = request.input.includes('latch') ? 'exit' : 'ok'
      chatRunMock.sessionOutputs.set(request.session_id, output)
      return { ok: true, output }
    })
    const workflow = manager.create({
      name: `Post-loop failure ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
        { id: 'fails-after', type: 'agent', data: { title: 'Fails', agent: 'hermes', input: 'fails-after' } },
        { id: 'failure-handler', type: 'agent', data: { title: 'Failure', agent: 'hermes', input: 'failure-handler' } },
        { id: 'always-handler', type: 'agent', data: { title: 'Always', agent: 'hermes', input: 'always-handler' } },
        { id: 'success-handler', type: 'agent', data: { title: 'Success', agent: 'hermes', input: 'success-handler' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 1 } } } },
        { id: 'exit', source: 'latch', target: 'fails-after' },
        { id: 'on-failure', source: 'fails-after', target: 'failure-handler', data: { orchestration: { route: 'failure' } } },
        { id: 'on-always', source: 'fails-after', target: 'always-handler', data: { orchestration: { route: 'always' } } },
        { id: 'on-success', source: 'fails-after', target: 'success-handler', data: { orchestration: { route: 'success' } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('failed')
      expect(result.run.error).toContain('post-loop boom')
      expect(result.nodeSessions.map(session => session.node_id)).toEqual(['header', 'latch', 'fails-after', 'failure-handler', 'always-handler'])
      expect(result.nodeSessions.some(session => session.node_id === 'success-handler')).toBe(false)
    } finally { await manager.delete(workflow.id) }
  })

  it('dispatches multiple loop exit targets only from persisted final-iteration evidence and skips untaken targets', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const { listWorkflowRunEdgeEvaluations } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.sessionOutputs.clear()
    const outputs = ['header-0', 'continue', 'header-1', 'stop', 'publish-done']
    const requests: Array<{ input: string }> = []
    chatRunMock.runAndWait.mockImplementation(async (request: { session_id: string; input: string }) => {
      requests.push({ input: request.input })
      const output = outputs.shift() || 'unexpected'
      chatRunMock.sessionOutputs.set(request.session_id, output)
      return { ok: true, output }
    })
    const workflow = manager.create({
      name: `Multiple loop exits ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
        { id: 'publish', type: 'agent', data: { title: 'Publish', agent: 'hermes', input: 'publish' } },
        { id: 'discard', type: 'agent', data: { title: 'Discard', agent: 'hermes', input: 'discard' } },
      ],
      edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: {
          route: 'success', feedback: { maxIterations: 3 },
          condition: { path: 'output', operator: 'equals', value: 'continue' },
        } } },
        { id: 'publish-exit', source: 'latch', target: 'publish', data: { orchestration: {
          route: 'success', condition: { path: 'output', operator: 'equals', value: 'stop' },
        } } },
        { id: 'discard-exit', source: 'latch', target: 'discard', data: { orchestration: {
          route: 'success', condition: { path: 'output', operator: 'equals', value: 'discard' },
        } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect({ status: result.run.status, error: result.run.error }).toEqual({ status: 'completed', error: null })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(5)
      expect(result.nodeSessions.map(session => [session.node_id, session.execution_id, session.status])).toEqual([
        ['header', 'header@loop:retry:0', 'completed'], ['latch', 'latch@loop:retry:0', 'completed'],
        ['header', 'header@loop:retry:1', 'completed'], ['latch', 'latch@loop:retry:1', 'completed'],
        ['publish', 'publish', 'completed'],
      ])
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses).toMatchObject({ publish: 'completed', discard: 'skipped' })
      expect(listWorkflowRunEdgeEvaluations(result.run.id).filter(item => ['publish-exit', 'discard-exit'].includes(item.edge_id)).map(item => [
        item.edge_id, item.status, item.source_execution_id, item.iteration_path,
      ])).toEqual([
        ['publish-exit', 'not_taken', 'latch@loop:retry:0', [{ loopId: 'loop:retry', iteration: 0 }]],
        ['discard-exit', 'not_taken', 'latch@loop:retry:0', [{ loopId: 'loop:retry', iteration: 0 }]],
        ['publish-exit', 'taken', 'latch@loop:retry:1', [{ loopId: 'loop:retry', iteration: 1 }]],
        ['discard-exit', 'not_taken', 'latch@loop:retry:1', [{ loopId: 'loop:retry', iteration: 1 }]],
      ])
      expect(requests[4].input).toContain('stop')
    } finally { await manager.delete(workflow.id) }
  })

  it('does not dispatch any loop exit target when final-iteration exit evidence cannot be persisted', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { getDb } = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const db = getDb()!
    db.exec(`CREATE TRIGGER fail_final_exit_evidence BEFORE INSERT ON workflow_run_edge_evaluations
      WHEN NEW.edge_id = 'publish-exit' AND NEW.source_execution_id LIKE '%:1'
      BEGIN SELECT RAISE(ABORT, 'final exit evidence write failed'); END`)
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'stop' })
    const workflow = manager.create({
      name: `Final exit evidence ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
        { id: 'publish', type: 'agent', data: { title: 'Publish', agent: 'hermes', input: 'publish' } },
        { id: 'discard', type: 'agent', data: { title: 'Discard', agent: 'hermes', input: 'discard' } },
      ],
      edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } } },
        { id: 'publish-exit', source: 'latch', target: 'publish' },
        { id: 'discard-exit', source: 'latch', target: 'discard', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'equals', value: 'discard' } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('failed')
      expect(result.run.error).toContain('final exit evidence write failed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(4)
      expect(result.nodeSessions.map(session => session.node_id)).toEqual(['header', 'latch', 'header', 'latch'])
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_final_exit_evidence')
      await manager.delete(workflow.id)
    }
  })

  it('applies approval rejection at the loop exit target boundary', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'stop' })
    const workflow = manager.create({
      name: `Exit approval ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
        { id: 'publish', type: 'agent', data: { title: 'Publish', agent: 'hermes', input: 'publish', approvalRequired: true } },
      ],
      edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 1 } } } },
        { id: 'publish-exit', source: 'latch', target: 'publish' },
      ],
    })
    try {
      const runPromise = manager.runNow(workflow.id)
      await vi.waitFor(() => expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.publish).toBe('pending_approval'))
      const runId = manager.getRuntimeStatus(workflow.id).runId!
      expect(manager.approveNode(workflow.id, runId, 'publish', false)).toBe(true)
      const result = await runPromise
      expect({ status: result.run.status, error: result.run.error }).toEqual({ status: 'failed', error: 'Workflow node approval rejected' })
      expect(result.nodeSessions.map(session => [session.node_id, session.status, session.error])).toEqual([
        ['header', 'completed', null], ['latch', 'completed', null], ['publish', 'approval_rejected', 'Workflow node approval rejected'],
      ])
    } finally { await manager.delete(workflow.id) }
  })

  it('does not dispatch a loop exit target after the shared run deadline', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    let now = 1000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    chatRunMock.runAndWait.mockReset().mockImplementation(async () => {
      now += 15
      return { ok: true, output: 'stop' }
    })
    const workflow = manager.create({
      name: `Exit deadline ${now}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
        { id: 'publish', type: 'agent', data: { title: 'Publish', agent: 'hermes', input: 'publish' } },
      ],
      edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 1 } } } },
        { id: 'publish-exit', source: 'latch', target: 'publish' },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id, { timeoutMs: 25 })
      expect({ status: result.run.status, error: result.run.error }).toEqual({ status: 'failed', error: 'workflow run timed out after 25ms' })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)
      expect(result.nodeSessions.map(session => [session.node_id, session.status])).toEqual([
        ['header', 'completed'], ['latch', 'failed'],
      ])
    } finally { nowSpy.mockRestore(); await manager.delete(workflow.id) }
  })

  it('finalizes a loop exit target when its approval reaches the shared deadline', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const manager = new WorkflowManager()
    let now = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    chatRunMock.runAndWait.mockReset().mockImplementation(async () => {
      now += 5
      return { ok: true, output: 'stop' }
    })
    const workflow = manager.create({
      name: `Exit approval deadline ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
        { id: 'publish', type: 'agent', data: { title: 'Publish', agent: 'hermes', input: 'publish', approvalRequired: true } },
      ],
      edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 1 } } } },
        { id: 'publish-exit', source: 'latch', target: 'publish' },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id, { timeoutMs: 20 })
      expect({ status: result.run.status, error: result.run.error }).toEqual({ status: 'failed', error: 'workflow run timed out after 20ms' })
      expect(result.nodeSessions.map(session => [session.node_id, session.status, session.error])).toEqual([
        ['header', 'completed', null], ['latch', 'completed', null], ['publish', 'failed', 'workflow run timed out after 20ms'],
      ])
      expect(manager.approveNode(workflow.id, result.run.id, 'publish', true)).toBe(false)
    } finally { nowSpy.mockRestore(); await manager.delete(workflow.id) }
  })

  it('keeps a canceled loop exit target canceled when its agent fails late', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRuns } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    let release!: () => void
    let targetStarted!: () => void
    const targetStartedPromise = new Promise<void>(resolve => { targetStarted = resolve })
    const releasePromise = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    chatRunMock.runAndWait.mockReset().mockImplementation(async () => {
      calls += 1
      if (calls < 3) return { ok: true, output: 'stop' }
      targetStarted()
      await releasePromise
      return { ok: false, error: 'late exit failure' }
    })
    const workflow = manager.create({
      name: `Canceled exit ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
        { id: 'publish', type: 'agent', data: { title: 'Publish', agent: 'hermes', input: 'publish' } },
      ],
      edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 1 } } } },
        { id: 'publish-exit', source: 'latch', target: 'publish' },
      ],
    })
    try {
      const runPromise = manager.runNow(workflow.id)
      await targetStartedPromise
      const runId = listWorkflowRuns(workflow.id)[0].id
      await manager.stopRun(workflow.id, runId, 'operator canceled exit')
      release()
      const result = await runPromise
      expect({ status: result.run.status, error: result.run.error }).toEqual({ status: 'canceled', error: 'operator canceled exit' })
      expect(result.nodeSessions.map(session => [session.node_id, session.status, session.error])).toEqual([
        ['header', 'completed', null], ['latch', 'completed', null], ['publish', 'canceled', 'operator canceled exit'],
      ])
    } finally { release(); await manager.delete(workflow.id) }
  })

  it('finalizes a failed downstream node after a top-level loop exits', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.sessionOutputs.clear()
    const outputs = ['header', 'stop']
    chatRunMock.runAndWait.mockImplementation(async (request: { session_id: string }) => {
      if (outputs.length > 0) {
        const output = outputs.shift()!
        chatRunMock.sessionOutputs.set(request.session_id, output)
        return { ok: true, output }
      }
      return { ok: false, error: 'exit exploded' }
    })
    const workflow = manager.create({
      name: `Failed loop downstream ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
        { id: 'exit', type: 'agent', data: { title: 'Exit', agent: 'hermes', input: 'exit' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: {
          route: 'success', feedback: { maxIterations: 2 },
          condition: { path: 'output', operator: 'equals', value: 'continue' },
        } } },
        { id: 'after-loop', source: 'latch', target: 'exit', data: { orchestration: {
          route: 'success', condition: { path: 'output', operator: 'equals', value: 'stop' },
        } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect({ status: result.run.status, error: result.run.error }).toEqual({ status: 'failed', error: 'exit exploded' })
      expect(result.nodeSessions.map(session => [session.node_id, session.status, session.error])).toEqual([
        ['header', 'completed', null], ['latch', 'completed', null], ['exit', 'failed', 'exit exploded'],
      ])
    } finally { await manager.delete(workflow.id) }
  })

  it('enforces one absolute deadline across sequential DAG executions', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    let now = 5000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const receivedTimeouts: Array<number | undefined> = []
    chatRunMock.runAndWait.mockReset().mockImplementation(async (_request: unknown, options: { timeoutMs?: number }) => {
      receivedTimeouts.push(options.timeoutMs)
      if (receivedTimeouts.length === 1) { now += 60; return { ok: true, output: 'first' } }
      return { ok: false, error: `chat-run timed out after ${options.timeoutMs}ms` }
    })
    const workflow = manager.create({
      name: `DAG run deadline ${now}`, profile: 'default',
      nodes: [
        { id: 'first', type: 'agent', data: { title: 'First', agent: 'hermes', input: 'first' } },
        { id: 'second', type: 'agent', data: { title: 'Second', agent: 'hermes', input: 'second' } },
      ], edges: [{ id: 'next', source: 'first', target: 'second' }],
    })
    try {
      const result = await manager.runNow(workflow.id, { timeoutMs: 100 })
      expect(receivedTimeouts).toEqual([100, 40])
      expect({ status: result.run.status, error: result.run.error }).toEqual({ status: 'failed', error: 'workflow run timed out after 100ms' })
      expect(result.nodeSessions.map(session => [session.node_id, session.status])).toEqual([
        ['first', 'completed'], ['second', 'failed'],
      ])
    } finally { nowSpy.mockRestore(); await manager.delete(workflow.id) }
  })

  it('times out and removes a pending DAG approval at the absolute run deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(7000)
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'review' })
    const workflow = manager.create({
      name: 'DAG approval deadline', profile: 'default',
      nodes: [{ id: 'review', type: 'agent', data: { title: 'Review', agent: 'hermes', input: 'review', approvalRequired: true } }],
      edges: [],
    })
    try {
      const runPromise = manager.runNow(workflow.id, { timeoutMs: 100 })
      await vi.advanceTimersByTimeAsync(0)
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.review).toBe('pending_approval')
      await vi.advanceTimersByTimeAsync(100)
      const result = await runPromise
      expect({ status: result.run.status, error: result.run.error }).toEqual({ status: 'failed', error: 'workflow run timed out after 100ms' })
      expect(result.nodeSessions.map(session => [session.status, session.error])).toEqual([['failed', 'workflow run timed out after 100ms']])
      expect(manager.approveNode(workflow.id, result.run.id, 'review', true)).toBe(false)
    } finally { vi.useRealTimers(); await manager.delete(workflow.id) }
  })

  it('runs only the matched success branch and skips the unmatched branch without creating a session', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'PASS' })
    const workflow = manager.create({
      name: `Conditional branch ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'source', type: 'agent', data: { title: 'Source', agent: 'hermes', input: 'source' } },
        { id: 'matched', type: 'agent', data: { title: 'Matched', agent: 'hermes', input: 'matched' } },
        { id: 'unmatched', type: 'agent', data: { title: 'Unmatched', agent: 'hermes', input: 'unmatched' } },
      ],
      edges: [
        { id: 'yes', source: 'source', target: 'matched', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'exists' } } } },
        { id: 'no', source: 'source', target: 'unmatched', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'equals', value: 'RETRY' } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('completed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)
      expect(result.nodeSessions.map(session => session.node_id).sort()).toEqual(['matched', 'source'])
      const { listWorkflowRunEdgeEvaluations } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
      expect(listWorkflowRunEdgeEvaluations(result.run.id).map(item => ({
        edge: item.edge_id, status: item.status, route: item.route, reason: item.reason,
        condition: item.condition_evaluation,
      }))).toEqual([
        { edge: 'yes', status: 'taken', route: 'success', reason: null, condition: { status: 'matched', actual: expect.any(String) } },
        { edge: 'no', status: 'not_taken', route: 'success', reason: 'condition_not_matched', condition: { status: 'not_matched', actual: expect.any(String), reason: 'not_equal' } },
      ])
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses).toMatchObject({ source: 'completed', matched: 'completed', unmatched: 'skipped' })
    } finally { await manager.delete(workflow.id) }
  })

  it('routes pretty-printed JSON output through structured fields instead of serialized text', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRunEdgeEvaluations } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    const structuredOutput = JSON.stringify({
      decision: 'RELEASED',
      route_token: 'HSR_RELEASED_OK',
    }, null, 2)
    chatRunMock.runAndWait.mockReset().mockImplementation(async (request: { session_id: string; input: string }) => {
      const output = request.input.includes('source') ? structuredOutput : 'handled'
      chatRunMock.sessionOutputs.set(request.session_id, output)
      return { ok: true, output }
    })
    const workflow = manager.create({
      name: `Structured JSON branch ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'source', type: 'agent', data: { title: 'Source', agent: 'hermes', input: 'source' } },
        { id: 'released', type: 'agent', data: { title: 'Released', agent: 'hermes', input: 'released' } },
        { id: 'blocked', type: 'agent', data: { title: 'Blocked', agent: 'hermes', input: 'blocked' } },
      ],
      edges: [
        { id: 'released-route', source: 'source', target: 'released', data: { orchestration: { route: 'success', condition: { path: 'outputJson.route_token', operator: 'equals', value: 'HSR_RELEASED_OK' } } } },
        { id: 'blocked-route', source: 'source', target: 'blocked', data: { orchestration: { route: 'success', condition: { path: 'outputJson.decision', operator: 'equals', value: 'BLOCKED' } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('completed')
      expect(result.nodeSessions.map(session => session.node_id).sort()).toEqual(['released', 'source'])
      expect(listWorkflowRunEdgeEvaluations(result.run.id).map(item => ({
        edge: item.edge_id, status: item.status, condition: item.condition_evaluation,
      }))).toEqual([
        { edge: 'released-route', status: 'taken', condition: { status: 'matched', actual: 'HSR_RELEASED_OK' } },
        { edge: 'blocked-route', status: 'not_taken', condition: { status: 'not_matched', actual: 'RELEASED', reason: 'not_equal' } },
      ])
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses).toMatchObject({
        source: 'completed', released: 'completed', blocked: 'skipped',
      })
    } finally { await manager.delete(workflow.id) }
  })

  it('fails structured paths closed when assistant output is malformed or ambiguous', async () => {
    const { evaluateWorkflowEdgeRoute, parseWorkflowStructuredOutput } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const condition = { path: 'outputJson.decision', operator: 'equals', value: 'RELEASED' } as const
    const outputs = [
      '```json\n{"decision":\n```',
      '```json\n{"decision":"RELEASED"}\n```\n```json\n{"decision":"BLOCKED"}\n```',
    ]

    for (const output of outputs) {
      const outputJson = parseWorkflowStructuredOutput(output)
      const context = outputJson === undefined ? { output } : { output, outputJson }
      expect(evaluateWorkflowEdgeRoute({ route: 'success', condition }, 'success', context)).toEqual({
        status: 'not_taken', routeMatched: true, reason: 'condition_not_matched',
        condition: { status: 'not_matched', reason: 'path_not_found' },
      })
    }
  })

  it('runs an any-join once when at least one incoming edge is taken', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'done' })
    const workflow = manager.create({
      name: `Any join ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'left', type: 'agent', data: { title: 'Left', agent: 'hermes', input: 'left' } },
        { id: 'right', type: 'agent', data: { title: 'Right', agent: 'hermes', input: 'right' } },
        { id: 'join', type: 'agent', data: { title: 'Join', agent: 'hermes', input: 'join', orchestration: { join: 'any' } } },
      ],
      edges: [
        { id: 'left-join', source: 'left', target: 'join', data: { orchestration: { route: 'success' } } },
        { id: 'right-join', source: 'right', target: 'join', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'equals', value: 'never' } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('completed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(3)
      expect(result.nodeSessions.filter(session => session.node_id === 'join')).toHaveLength(1)
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.join).toBe('completed')
    } finally { await manager.delete(workflow.id) }
  })

  it('starts an any-join after the first taken edge without waiting for another running source', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    let releaseSlow!: () => void
    const slow = new Promise<{ ok: true; output: string }>(resolve => { releaseSlow = () => resolve({ ok: true, output: 'slow' }) })
    chatRunMock.runAndWait.mockReset()
    chatRunMock.runAndWait.mockImplementation(async (request: { input: string }) => {
      if (request.input.includes('slow')) return slow
      return { ok: true, output: 'done' }
    })
    const workflow = manager.create({
      name: `Completion driven ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'fast', type: 'agent', data: { title: 'Fast', agent: 'hermes', input: 'fast' } },
        { id: 'slow', type: 'agent', data: { title: 'Slow', agent: 'hermes', input: 'slow' } },
        { id: 'join', type: 'agent', data: { title: 'Join', agent: 'hermes', input: 'join', orchestration: { join: 'any' } } },
      ],
      edges: [
        { id: 'fast-join', source: 'fast', target: 'join' },
        { id: 'slow-join', source: 'slow', target: 'join' },
      ],
    })
    try {
      const runPromise = manager.runNow(workflow.id)
      await vi.waitFor(() => expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.fast).toBe('completed'))
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.slow).toBe('running')
      await vi.waitFor(() => expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.join).toBe('completed'))
      let settled = false
      void runPromise.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      releaseSlow()
      await expect(runPromise).resolves.toMatchObject({ run: { status: 'completed' } })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(3)
    } finally { releaseSlow?.(); await manager.delete(workflow.id) }
  })

  it('runs failure and always branches after a failed node while skipping its success branch', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.runAndWait
      .mockResolvedValueOnce({ ok: false, error: 'source failed' })
      .mockResolvedValue({ ok: true, output: 'handled' })
    const workflow = manager.create({
      name: `Failure branch ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'source', type: 'agent', data: { title: 'Source', agent: 'hermes', input: 'source' } },
        { id: 'on-success', type: 'agent', data: { title: 'Success', agent: 'hermes', input: 'success' } },
        { id: 'on-failure', type: 'agent', data: { title: 'Failure', agent: 'hermes', input: 'failure' } },
        { id: 'always', type: 'agent', data: { title: 'Always', agent: 'hermes', input: 'always' } },
      ],
      edges: [
        { id: 'success', source: 'source', target: 'on-success', data: { orchestration: { route: 'success' } } },
        { id: 'failure', source: 'source', target: 'on-failure', data: { orchestration: { route: 'failure' } } },
        { id: 'always', source: 'source', target: 'always', data: { orchestration: { route: 'always' } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('failed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(3)
      expect(result.nodeSessions.map(session => session.node_id).sort()).toEqual(['always', 'on-failure', 'source'])
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses).toMatchObject({
        source: 'failed', 'on-success': 'skipped', 'on-failure': 'completed', always: 'completed',
      })
    } finally { await manager.delete(workflow.id) }
  })

  it('pauses downstream nodes until an approval-required node is approved', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.abortSession.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'done' })

    const workflow = manager.create({
      name: `Approval gate ${Date.now()}`,
      profile: 'default',
      nodes: [
        {
          id: 'first',
          type: 'agent',
          data: {
            title: 'First',
            agent: 'hermes',
            input: 'first task',
            approvalRequired: true,
          },
        },
        {
          id: 'second',
          type: 'agent',
          data: {
            title: 'Second',
            agent: 'hermes',
            input: 'second task',
          },
        },
      ],
      edges: [{ id: 'first-second', source: 'first', target: 'second' }],
    })

    try {
      const runPromise = manager.runNow(workflow.id)
      await vi.waitFor(() => {
        expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.first).toBe('pending_approval')
      })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)

      const runId = manager.getRuntimeStatus(workflow.id).runId
      expect(runId).toBeTruthy()
      expect(manager.approveNode(workflow.id, runId!, 'first', true)).toBe(true)

      await expect(runPromise).resolves.toMatchObject({
        run: { status: 'completed' },
      })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.second).toBe('completed')
    } finally {
      await manager.delete(workflow.id)
    }
  })

  it('keeps a DAG approval wait canceled when stopRun resolves the pending approval', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRunNodeSessions } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'needs approval' })
    chatRunMock.abortSession.mockReset().mockResolvedValue(undefined)
    const workflow = manager.create({
      name: `Canceled DAG approval ${Date.now()}`, profile: 'default',
      nodes: [{ id: 'review', type: 'agent', data: {
        title: 'Review', agent: 'hermes', input: 'review', approvalRequired: true,
      } }], edges: [],
    })
    try {
      const runPromise = manager.runNow(workflow.id)
      await vi.waitFor(() => expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.review).toBe('pending_approval'))
      const runId = manager.getRuntimeStatus(workflow.id).runId!
      await manager.stopRun(workflow.id, runId, 'canceled during approval')
      const result = await runPromise
      expect({ status: result.run.status, error: result.run.error }).toEqual({
        status: 'canceled', error: 'canceled during approval',
      })
      expect(listWorkflowRunNodeSessions(runId).map(session => [session.status, session.error])).toEqual([
        ['canceled', 'canceled during approval'],
      ])
      expect(manager.getRuntimeStatus(workflow.id)).toMatchObject({
        status: 'canceled', error: 'canceled during approval', nodeStatuses: { review: 'canceled' },
      })
    } finally { await manager.delete(workflow.id) }
  })

  it('keeps parallel pending approvals open after one node is rejected', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.abortSession.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'done' })

    const workflow = manager.create({
      name: `Parallel approvals ${Date.now()}`,
      profile: 'default',
      nodes: [
        {
          id: 'first',
          type: 'agent',
          data: { title: 'First', agent: 'hermes', input: 'first task', approvalRequired: true },
        },
        {
          id: 'second',
          type: 'agent',
          data: { title: 'Second', agent: 'hermes', input: 'second task', approvalRequired: true },
        },
        {
          id: 'join',
          type: 'agent',
          data: { title: 'Join', agent: 'hermes', input: 'join task' },
        },
      ],
      edges: [
        { id: 'first-join', source: 'first', target: 'join' },
        { id: 'second-join', source: 'second', target: 'join' },
      ],
    })

    try {
      const runPromise = manager.runNow(workflow.id)
      await vi.waitFor(() => {
        const statuses = manager.getRuntimeStatus(workflow.id).nodeStatuses
        expect(statuses.first).toBe('pending_approval')
        expect(statuses.second).toBe('pending_approval')
      })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)

      const runId = manager.getRuntimeStatus(workflow.id).runId
      expect(runId).toBeTruthy()
      expect(manager.approveNode(workflow.id, runId!, 'first', false)).toBe(true)
      await vi.waitFor(() => {
        const statuses = manager.getRuntimeStatus(workflow.id).nodeStatuses
        expect(statuses.first).toBe('approval_rejected')
        expect(statuses.second).toBe('pending_approval')
      })

      expect(manager.approveNode(workflow.id, runId!, 'second', true)).toBe(true)
      await expect(runPromise).resolves.toMatchObject({
        run: { status: 'failed' },
      })
      const finalStatuses = manager.getRuntimeStatus(workflow.id).nodeStatuses
      expect(finalStatuses.first).toBe('approval_rejected')
      expect(finalStatuses.second).toBe('completed')
      expect(finalStatuses.join).toBe('canceled')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)
    } finally {
      await manager.delete(workflow.id)
    }
  })

  it('fails closed before starting a target node when edge evidence persistence fails', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { getDb } = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const db = getDb()!
    db.exec(`CREATE TRIGGER fail_workflow_edge_evidence BEFORE INSERT ON workflow_run_edge_evaluations BEGIN SELECT RAISE(ABORT, 'edge evidence write failed'); END`)
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'done' })
    const workflow = manager.create({
      name: `Evidence failure ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'source', type: 'agent', data: { title: 'Source', agent: 'hermes', input: 'source' } },
        { id: 'target', type: 'agent', data: { title: 'Target', agent: 'hermes', input: 'target' } },
      ], edges: [{ id: 'source-target', source: 'source', target: 'target' }],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('failed')
      expect(result.run.error).toContain('edge evidence write failed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
      expect(result.nodeSessions.map(session => session.node_id)).toEqual(['source'])
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.target).toBe('canceled')
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_workflow_edge_evidence')
      await manager.delete(workflow.id)
    }
  })

  it('stores distinct execution instances for repeated loop node sessions', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { createWorkflowRun, createWorkflowRunNodeSession, deleteWorkflowRun, listWorkflowRunNodeSessions } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    initAllStores()
    const run = createWorkflowRun({ workflow_id: `instances-${Date.now()}` })
    createWorkflowRunNodeSession({ run_id: run.id, workflow_id: run.workflow_id, node_id: 'header', session_id: 'header-0', execution_id: 'header@0', iteration_path: [{ loopId: 'loop:retry', iteration: 0 }], sequence: 0 })
    createWorkflowRunNodeSession({ run_id: run.id, workflow_id: run.workflow_id, node_id: 'header', session_id: 'header-1', execution_id: 'header@1', iteration_path: [{ loopId: 'loop:retry', iteration: 1 }], sequence: 1 })
    expect(listWorkflowRunNodeSessions(run.id).map(item => [item.execution_id, item.iteration_path])).toEqual([
      ['header@0', [{ loopId: 'loop:retry', iteration: 0 }]],
      ['header@1', [{ loopId: 'loop:retry', iteration: 1 }]],
    ])
    expect(deleteWorkflowRun(run.id)).toBe(true)
  })

  it('round-trips the compiled loop snapshot with a workflow run', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { createWorkflowRun, deleteWorkflowRun, getWorkflowRun } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    initAllStores()
    const compiledLoops = [{ id: 'loop:retry', feedbackEdgeId: 'retry', headerNodeId: 'a', latchNodeId: 'b', bodyNodeIds: ['a', 'b'], maxIterations: 3, parentLoopId: null }]
    const run = createWorkflowRun({ workflow_id: `snapshot-${Date.now()}`, compiled_loops: compiledLoops })
    expect(getWorkflowRun(run.id)?.compiled_loops).toEqual(compiledLoops)
    expect(deleteWorkflowRun(run.id)).toBe(true)
  })

  it('stores edge evaluations append-only and deletes them atomically with the run', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const {
      createWorkflowRun, createWorkflowRunEdgeEvaluation, createWorkflowRunLoopEpoch, deleteWorkflowRun,
      listWorkflowRunEdgeEvaluations, listWorkflowRunLoopEpochs,
    } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    initAllStores()
    const run = createWorkflowRun({ workflow_id: `evidence-${Date.now()}`, status: 'running' })
    createWorkflowRunEdgeEvaluation({
      run_id: run.id, workflow_id: run.workflow_id, edge_id: 'edge-a', source_node_id: 'source',
      target_node_id: 'target', source_outcome: 'success', status: 'not_taken', route: 'success',
      reason: 'condition_not_matched', sequence: 2, orchestration: { route: 'success' },
      condition_evaluation: { status: 'not_matched', actual: 'RETRY', reason: 'not_equal' },
    })
    createWorkflowRunEdgeEvaluation({
      run_id: run.id, workflow_id: run.workflow_id, edge_id: 'edge-b', source_node_id: 'source',
      target_node_id: 'other', source_outcome: 'success', status: 'taken', route: 'always',
      sequence: 1, orchestration: { route: 'always' }, condition_evaluation: null,
    })
    expect(listWorkflowRunEdgeEvaluations(run.id).map(item => [item.edge_id, item.sequence, item.status, item.source_execution_id, item.iteration_path])).toEqual([
      ['edge-b', 1, 'taken', 'source', []], ['edge-a', 2, 'not_taken', 'source', []],
    ])
    createWorkflowRunLoopEpoch({ run_id: run.id, workflow_id: run.workflow_id, loop_id: 'loop:test', iteration: 0,
      iteration_path: [{ loopId: 'loop:test', iteration: 0 }], status: 'completed', exit_reason: 'iteration_limit_reached',
      sequence: 0, started_at: 1, finished_at: 2 })
    expect(listWorkflowRunLoopEpochs(run.id)).toHaveLength(1)
    expect(deleteWorkflowRun(run.id)).toBe(true)
    expect(listWorkflowRunEdgeEvaluations(run.id)).toEqual([])
    expect(listWorkflowRunLoopEpochs(run.id)).toEqual([])
  })

  it('rejects an invalid rerun snapshot before deleting sessions or mutating the run', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const { createWorkflowRun, createWorkflowRunNodeSession, getWorkflowRun, listWorkflowRunNodeSessions, updateWorkflowRun } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    const nodes = [{ id: 'a', type: 'agent', data: { title: 'A', agent: 'hermes', input: 'a' } }]
    const workflow = manager.create({ name: `Invalid rerun ${Date.now()}`, profile: 'default', nodes, edges: [] })
    const run = createWorkflowRun({ workflow_id: workflow.id, status: 'running', snapshot_nodes: nodes, snapshot_edges: [{ id: 'bad', source: 'a', target: 'missing' }] })
    createWorkflowRunNodeSession({ run_id: run.id, workflow_id: workflow.id, node_id: 'a', session_id: 'existing-a', status: 'canceled' })
    updateWorkflowRun(run.id, { status: 'canceled', finished_at: 1100 })
    try {
      await expect(manager.rerunFromNode(workflow.id, run.id, 'a')).rejects.toThrow('workflow edge bad references missing node')
      expect(getWorkflowRun(run.id)?.status).toBe('canceled')
      expect(listWorkflowRunNodeSessions(run.id).map(item => item.session_id)).toEqual(['existing-a'])
      expect(chatRunMock.runAndWait).not.toHaveBeenCalled()
    } finally { await manager.delete(workflow.id) }
  })

  it('revalidates portable skills on rerun and fails closed before mutating the run', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const {
      createWorkflowRun, createWorkflowRunNodeSession, getWorkflowRun,
      listWorkflowRunNodeSessions, updateWorkflowRun,
    } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    const missingSkill = `missing-rerun-skill-${Date.now()}`
    const nodes = [{ id: 'agent', type: 'agent', data: {
      title: 'Agent', agent: 'hermes', input: 'work', skills: [missingSkill],
    } }]
    const workflow = manager.create({
      name: `Missing rerun skill ${Date.now()}`,
      profile: 'default',
      nodes,
      edges: [],
    })
    const run = createWorkflowRun({
      workflow_id: workflow.id, profile: 'default', status: 'running',
      snapshot_nodes: nodes, snapshot_edges: [], start_node_ids: ['agent'],
      started_at: 1000, finished_at: 1100,
    })
    createWorkflowRunNodeSession({
      run_id: run.id, workflow_id: workflow.id, node_id: 'agent',
      session_id: 'existing-agent', status: 'canceled',
    })
    updateWorkflowRun(run.id, { status: 'canceled', finished_at: 1100 })
    const beforeRun = getWorkflowRun(run.id)
    try {
      await expect(manager.rerunFromNode(workflow.id, run.id, 'agent')).rejects.toMatchObject({
        message: `workflow node agent requires unavailable skill: ${missingSkill}`,
        status: 409,
      })
      expect(getWorkflowRun(run.id)).toEqual(beforeRun)
      expect(listWorkflowRunNodeSessions(run.id).map(item => item.session_id)).toEqual(['existing-agent'])
      expect(chatRunMock.runAndWait).not.toHaveBeenCalled()
    } finally { await manager.delete(workflow.id) }
  })

  it('rejects an over-budget rerun before deleting sessions or mutating the run', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { createWorkflowRun, createWorkflowRunNodeSession, getWorkflowRun, listWorkflowRunNodeSessions, updateWorkflowRun } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    const nodes = Array.from({ length: 11 }, (_, index) => ({
      id: `n${index}`, type: 'agent', data: { title: `N${index}`, agent: 'hermes', input: `n${index}` },
    }))
    const edges: any[] = Array.from({ length: 10 }, (_, index) => ({ id: `e${index}`, source: `n${index}`, target: `n${index + 1}` }))
    edges.push({ id: 'retry', source: 'n10', target: 'n0', data: { orchestration: { route: 'success', feedback: { maxIterations: 100 } } } })
    const workflow = manager.create({ name: `Over-budget rerun ${Date.now()}`, profile: 'default', nodes, edges })
    const run = createWorkflowRun({
      workflow_id: workflow.id, status: 'running', snapshot_nodes: nodes, snapshot_edges: edges,
      start_node_ids: ['n0'], started_at: 1000, finished_at: 1100,
    })
    createWorkflowRunNodeSession({ run_id: run.id, workflow_id: workflow.id, node_id: 'n0', session_id: 'existing-n0', status: 'canceled' })
    updateWorkflowRun(run.id, { status: 'canceled', finished_at: 1100 })
    const beforeRun = getWorkflowRun(run.id)
    try {
      await expect(manager.rerunFromNode(workflow.id, run.id, 'n0')).rejects.toThrow('workflow static execution bound 1100 exceeds run budget 1000')
      expect(getWorkflowRun(run.id)).toEqual(beforeRun)
      expect(listWorkflowRunNodeSessions(run.id).map(session => session.session_id)).toEqual(['existing-n0'])
      expect(chatRunMock.runAndWait).not.toHaveBeenCalled()
    } finally { await manager.delete(workflow.id) }
  })

  it('enforces a fresh absolute deadline across sequential rerun executions', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { createWorkflowRun, createWorkflowRunNodeSession, updateWorkflowRun } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    let now = 9000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const receivedTimeouts: Array<number | undefined> = []
    chatRunMock.runAndWait.mockReset().mockImplementation(async (_request: unknown, options: { timeoutMs?: number }) => {
      receivedTimeouts.push(options.timeoutMs)
      if (receivedTimeouts.length === 1) { now += 70; return { ok: true, output: 'first' } }
      return { ok: false, error: `chat-run timed out after ${options.timeoutMs}ms` }
    })
    const nodes = [
      { id: 'first', type: 'agent', data: { title: 'First', agent: 'hermes', input: 'first' } },
      { id: 'second', type: 'agent', data: { title: 'Second', agent: 'hermes', input: 'second' } },
    ]
    const edges = [{ id: 'next', source: 'first', target: 'second' }]
    const workflow = manager.create({ name: `Rerun deadline ${now}`, profile: 'default', nodes, edges })
    const run = createWorkflowRun({
      workflow_id: workflow.id, profile: 'default', status: 'running', snapshot_nodes: nodes, snapshot_edges: edges,
      started_at: 1000, finished_at: 1100,
    })
    for (const [sequence, nodeId] of ['first', 'second'].entries()) createWorkflowRunNodeSession({
      run_id: run.id, workflow_id: workflow.id, node_id: nodeId, session_id: `old-${nodeId}`, status: 'canceled', sequence,
    })
    updateWorkflowRun(run.id, { status: 'canceled', finished_at: 1100 })
    try {
      const result = await manager.rerunFromNode(workflow.id, run.id, 'first', { timeoutMs: 100 })
      expect(receivedTimeouts).toEqual([100, 30])
      expect(result.run).toMatchObject({
        requested_timeout_ms: 100,
        deadline_at: 9100,
      })
      expect(result.nodeSessions.filter(session => session.started_at !== null && session.started_at >= 9000)
        .map(session => [session.node_id, session.remaining_timeout_ms_at_start])).toEqual([
        ['first', 100], ['second', 30],
      ])
      expect({ status: result.run.status, error: result.run.error, startedAt: result.run.started_at }).toEqual({
        status: 'failed', error: 'workflow run timed out after 100ms', startedAt: 9000,
      })
    } finally { nowSpy.mockRestore(); await manager.delete(workflow.id) }
  })

  it('times out and removes a pending rerun approval at its fresh deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(12000)
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { createWorkflowRun, createWorkflowRunNodeSession, updateWorkflowRun } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'review' })
    const nodes = [{ id: 'review', type: 'agent', data: { title: 'Review', agent: 'hermes', input: 'review', approvalRequired: true } }]
    const workflow = manager.create({ name: 'Rerun approval deadline', profile: 'default', nodes, edges: [] })
    const run = createWorkflowRun({ workflow_id: workflow.id, status: 'running', snapshot_nodes: nodes, snapshot_edges: [], started_at: 1000 })
    createWorkflowRunNodeSession({ run_id: run.id, workflow_id: workflow.id, node_id: 'review', session_id: 'old-review', status: 'canceled' })
    updateWorkflowRun(run.id, { status: 'canceled', finished_at: 1100 })
    try {
      const rerunPromise = manager.rerunFromNode(workflow.id, run.id, 'review', { timeoutMs: 100 })
      await vi.advanceTimersByTimeAsync(0)
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.review).toBe('pending_approval')
      await vi.advanceTimersByTimeAsync(100)
      const result = await rerunPromise
      expect({ status: result.run.status, error: result.run.error, startedAt: result.run.started_at }).toEqual({
        status: 'failed', error: 'workflow run timed out after 100ms', startedAt: 12000,
      })
      expect(result.nodeSessions.map(session => [session.status, session.error])).toEqual([
        ['canceled', null], ['failed', 'workflow run timed out after 100ms'],
      ])
      expect(manager.approveNode(workflow.id, run.id, 'review', true)).toBe(false)
    } finally { vi.useRealTimers(); await manager.delete(workflow.id) }
  })

  it('runs a fresh partial start without requiring historical evidence from inactive upstream nodes', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'done' })
    const workflow = manager.create({
      name: `Fresh partial start ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'upstream', type: 'agent', data: { title: 'Upstream', agent: 'hermes', input: 'upstream' } },
        { id: 'selected', type: 'agent', data: { title: 'Selected', agent: 'hermes', input: 'selected' } },
        { id: 'downstream', type: 'agent', data: { title: 'Downstream', agent: 'hermes', input: 'downstream' } },
      ],
      edges: [
        { id: 'upstream-selected', source: 'upstream', target: 'selected' },
        { id: 'selected-downstream', source: 'selected', target: 'downstream' },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id, { startNodeIds: ['selected'] })
      expect(result.run.status).toBe('completed')
      expect(result.run.start_node_ids).toEqual(['selected'])
      expect(result.nodeSessions.map(item => item.node_id)).toEqual(['selected', 'downstream'])
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)
    } finally { await manager.delete(workflow.id) }
  })

  it('non-preserve rerun clears the selected node and ignores its historical incoming decisions', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    let sourceOutput = 'stop'
    chatRunMock.runAndWait.mockReset().mockImplementation(async (request: { session_id: string; input: string }) => {
      const output = request.input.includes('source') ? sourceOutput : 'target-ran'
      chatRunMock.sessionOutputs.set(request.session_id, output)
      return { ok: true, output }
    })
    const workflow = manager.create({
      name: `Forced rerun start ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'source', type: 'agent', data: { title: 'Source', agent: 'hermes', input: 'source' } },
        { id: 'target', type: 'agent', data: { title: 'Target', agent: 'hermes', input: 'target' } },
      ],
      edges: [{ id: 'conditional', source: 'source', target: 'target', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'equals', value: 'go' } } } }],
    })
    try {
      const fresh = await manager.runNow(workflow.id)
      expect(fresh.nodeSessions.map(item => item.node_id)).toEqual(['source'])
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.target).toBe('skipped')
      chatRunMock.runAndWait.mockClear()
      sourceOutput = 'still-stop'

      const rerun = await manager.rerunFromNode(workflow.id, fresh.run.id, 'target')

      expect(rerun.run.status).toBe('completed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
      expect(rerun.nodeSessions.filter(item => item.execution_id.includes('@rerun:')).map(item => item.node_id)).toEqual(['target'])
    } finally { await manager.delete(workflow.id) }
  })

  it('preserve rerun follows only taken routes and skips an all-join blocked by persisted not-taken evidence', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRunNodeSessions } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockImplementation(async (request: { session_id: string; input: string }) => {
      const output = request.input.includes('blocked-source') ? 'no' : 'go'
      chatRunMock.sessionOutputs.set(request.session_id, output)
      return { ok: true, output }
    })
    const workflow = manager.create({
      name: `Preserved not taken join ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'preserved', type: 'agent', data: { title: 'Preserved', agent: 'hermes', input: 'preserved' } },
        { id: 'blocked-source', type: 'agent', data: { title: 'Blocked source', agent: 'hermes', input: 'blocked-source' } },
        { id: 'join', type: 'agent', data: { title: 'Join', agent: 'hermes', input: 'join', orchestration: { join: 'all' } } },
      ],
      edges: [
        { id: 'preserved-join', source: 'preserved', target: 'join' },
        { id: 'blocked-join', source: 'blocked-source', target: 'join', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'equals', value: 'go' } } } },
      ],
    })
    try {
      const fresh = await manager.runNow(workflow.id)
      expect(fresh.nodeSessions.map(item => item.node_id)).toEqual(['preserved', 'blocked-source'])
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.join).toBe('skipped')
      chatRunMock.runAndWait.mockClear()

      const rerun = await manager.rerunFromNode(workflow.id, fresh.run.id, 'preserved', { preserveStartNode: true })

      expect(rerun.run.status).toBe('completed')
      expect(chatRunMock.runAndWait).not.toHaveBeenCalled()
      expect(listWorkflowRunNodeSessions(fresh.run.id).filter(item => item.node_id === 'join')).toEqual([])
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.join).toBe('skipped')
    } finally { await manager.delete(workflow.id) }
  })

  it('rejects preserve rerun when the latest source execution has no taken downstream route', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockImplementation(async (request: { session_id: string }) => {
      chatRunMock.sessionOutputs.set(request.session_id, 'stop')
      return { ok: true, output: 'stop' }
    })
    const workflow = manager.create({
      name: `No taken preserve route ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'source', type: 'agent', data: { title: 'Source', agent: 'hermes', input: 'source' } },
        { id: 'target', type: 'agent', data: { title: 'Target', agent: 'hermes', input: 'target' } },
      ],
      edges: [{ id: 'conditional', source: 'source', target: 'target', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'equals', value: 'go' } } } }],
    })
    try {
      const fresh = await manager.runNow(workflow.id)
      await expect(manager.rerunFromNode(workflow.id, fresh.run.id, 'source', { preserveStartNode: true }))
        .rejects.toThrow('no taken downstream route')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
    } finally { await manager.delete(workflow.id) }
  })

  it('rerun consumes only the latest preserved upstream taken-edge evidence', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRunEdgeEvaluations, listWorkflowRunNodeSessions } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    const requests: Array<{ input: string }> = []
    chatRunMock.runAndWait.mockReset().mockImplementation(async (request: { session_id: string; input: string }) => {
      requests.push({ input: request.input })
      const output = request.input.includes('source') ? 'authoritative-source-output' : 'downstream-output'
      chatRunMock.sessionOutputs.set(request.session_id, output)
      return { ok: true, output }
    })
    const workflow = manager.create({
      name: `Rerun preserved provenance ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'source', type: 'agent', data: { title: 'Source', agent: 'hermes', input: 'source' } },
        { id: 'downstream', type: 'agent', data: { title: 'Downstream', agent: 'hermes', input: 'downstream' } },
      ],
      edges: [{ id: 'source-downstream', source: 'source', target: 'downstream' }],
    })
    try {
      const fresh = await manager.runNow(workflow.id)
      const taken = listWorkflowRunEdgeEvaluations(fresh.run.id).find(item => item.edge_id === 'source-downstream')!
      chatRunMock.runAndWait.mockClear()
      requests.length = 0

      const rerun = await manager.rerunFromNode(workflow.id, fresh.run.id, 'source', { preserveStartNode: true })

      expect(rerun.run.status).toBe('completed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
      expect(requests[0].input).toContain('authoritative-source-output')
      const latestDownstream = listWorkflowRunNodeSessions(fresh.run.id).filter(item => item.node_id === 'downstream').at(-1)!
      expect(latestDownstream.execution_id).toContain('@rerun:')
      expect(latestDownstream.consumed_edge_evaluation_ids).toEqual([taken.id])
      expect(taken.sequence).toBeLessThan(latestDownstream.sequence)
    } finally { await manager.delete(workflow.id) }
  })

  it('accepts only one concurrent rerun lifecycle for the same terminal Run', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'done' })
    let release: (() => void) | undefined
    const workflow = manager.create({
      name: `Concurrent rerun acceptance ${Date.now()}`, profile: 'default',
      nodes: [{ id: 'node', type: 'agent', data: { title: 'Node', agent: 'hermes', input: 'node' } }], edges: [],
    })
    try {
      const fresh = await manager.runNow(workflow.id)
      const held = new Promise<{ ok: true; output: string }>(resolve => { release = () => resolve({ ok: true, output: 'rerun' }) })
      chatRunMock.runAndWait.mockReset().mockImplementation(() => held)
      const first = manager.rerunFromNode(workflow.id, fresh.run.id, 'node')
      await vi.waitFor(() => expect(manager.getRuntimeStatus(workflow.id).status).toBe('running'))
      await expect(manager.rerunFromNode(workflow.id, fresh.run.id, 'node')).rejects.toThrow('still active')
      release!()
      await expect(first).resolves.toMatchObject({ run: { status: 'completed' } })
    } finally { release?.(); await manager.delete(workflow.id) }
  })

  it('reruns a bounded loop through the same recursive scheduler semantics as a fresh run', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRunEdgeEvaluations, listWorkflowRunLoopEpochs } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'continue' })
    const workflow = manager.create({
      name: `Rerun loop scheduler ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ], edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } } },
      ],
    })
    try {
      const fresh = await manager.runNow(workflow.id)
      expect(fresh.run.status).toBe('completed')
      chatRunMock.runAndWait.mockClear()

      const rerun = await manager.rerunFromNode(workflow.id, fresh.run.id, 'header')

      expect({ status: rerun.run.status, error: rerun.run.error }).toEqual({ status: 'completed', error: null })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(4)
      const scoped = rerun.nodeSessions.filter(session => session.execution_id.includes('@rerun:'))
      const rerunPaths = scoped.map(session => session.iteration_path as Array<Record<string, unknown>>)
      const executionScope = rerunPaths[0]?.[0]?.executionScope
      expect(executionScope).toMatch(/^rerun:\d+$/)
      expect(rerunPaths.every(path => path.every(item => item.executionScope === executionScope))).toBe(true)
      expect(scoped.map(session => [session.node_id, (session.iteration_path as Array<Record<string, unknown>>).map(({ executionScope: _scope, ...item }) => item)])).toEqual([
        ['header', [{ loopId: 'loop:retry', iteration: 0 }]],
        ['latch', [{ loopId: 'loop:retry', iteration: 0 }]],
        ['header', [{ loopId: 'loop:retry', iteration: 1 }]],
        ['latch', [{ loopId: 'loop:retry', iteration: 1 }]],
      ])
      expect(new Set(scoped.map(session => session.execution_id)).size).toBe(4)
      expect(scoped.every(session => session.execution_id.includes(String(executionScope)))).toBe(true)
      expect(rerun.nodeSessions).toHaveLength(8)
      const nodeEvidence = rerun.nodeSessions.map(item => ({ kind: 'node', sequence: item.sequence }))
      const edgeEvidence = listWorkflowRunEdgeEvaluations(fresh.run.id).map(item => ({ kind: 'edge', sequence: item.sequence }))
      const loopEvidence = listWorkflowRunLoopEpochs(fresh.run.id).map(item => ({ kind: 'loop', sequence: item.sequence }))
      const timeline = [...nodeEvidence, ...edgeEvidence, ...loopEvidence].sort((a, b) => a.sequence - b.sequence)
      expect(timeline.map(item => item.sequence)).toEqual(Array.from({ length: timeline.length }, (_, index) => index))
      expect(new Set(timeline.map(item => item.sequence)).size).toBe(timeline.length)
      expect(timeline.slice(-10).map(item => item.kind)).toEqual([
        'node', 'edge', 'node', 'edge', 'loop',
        'node', 'edge', 'node', 'edge', 'loop',
      ])
    } finally { await manager.delete(workflow.id) }
  })

  it('reruns a strictly nested loop with scoped canonical iteration paths', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'continue' })
    const agent = (id: string) => ({ id, type: 'agent', data: { title: id, agent: 'hermes', input: id } })
    const feedback = (id: string, source: string, target: string) => ({ id, source, target, data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } } })
    const workflow = manager.create({
      name: `Rerun nested loop ${Date.now()}`, profile: 'default',
      nodes: ['outer-h', 'inner-h', 'inner-l', 'outer-l'].map(agent), edges: [
        { id: 'outer-inner', source: 'outer-h', target: 'inner-h' },
        { id: 'inner-forward', source: 'inner-h', target: 'inner-l' },
        { id: 'inner-outer', source: 'inner-l', target: 'outer-l' },
        feedback('inner-retry', 'inner-l', 'inner-h'), feedback('outer-retry', 'outer-l', 'outer-h'),
      ],
    })
    try {
      const fresh = await manager.runNow(workflow.id)
      chatRunMock.runAndWait.mockClear()
      const rerun = await manager.rerunFromNode(workflow.id, fresh.run.id, 'outer-h')
      expect(rerun.run.status).toBe('completed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(12)
      const scoped = rerun.nodeSessions.filter(session => session.execution_id.includes('@rerun:'))
      expect(scoped).toHaveLength(12)
      const finalInner = scoped.filter(session => session.node_id === 'inner-h').at(-1)!
      expect(finalInner.iteration_path).toEqual([
        expect.objectContaining({ loopId: 'loop:outer-retry', iteration: 1, executionScope: expect.stringMatching(/^rerun:/) }),
        expect.objectContaining({ loopId: 'loop:inner-retry', iteration: 1, executionScope: expect.stringMatching(/^rerun:/) }),
      ])
    } finally { await manager.delete(workflow.id) }
  })

  it('attributes failures to the correct disjoint loop epoch without leaking another loop error', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRunLoopEpochs } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockImplementation(async (request: { input: string }) => {
      if (request.input.includes('a-h')) return { ok: false, error: 'loop-a-failed' }
      if (request.input.includes('b-h')) return { ok: false, error: 'loop-b-failed' }
      return { ok: true, output: 'done' }
    })
    const agent = (id: string) => ({ id, type: 'agent', data: { title: id, agent: 'hermes', input: id } })
    const workflow = manager.create({
      name: `Disjoint failure attribution ${Date.now()}`, profile: 'default',
      nodes: ['a-h', 'a-l', 'b-h', 'b-l'].map(agent),
      edges: [
        { id: 'a-forward', source: 'a-h', target: 'a-l' },
        { id: 'a-retry', source: 'a-l', target: 'a-h', data: { orchestration: { route: 'success', feedback: { maxIterations: 2, loopId: 'loop-a' } } } },
        { id: 'b-forward', source: 'b-h', target: 'b-l' },
        { id: 'b-retry', source: 'b-l', target: 'b-h', data: { orchestration: { route: 'success', feedback: { maxIterations: 2, loopId: 'loop-b' } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('failed')
      expect(listWorkflowRunLoopEpochs(result.run.id).map(epoch => [epoch.loop_id, epoch.status, epoch.exit_reason]).sort()).toEqual([
        ['loop-a', 'failed', 'loop-a-failed'],
        ['loop-b', 'failed', 'loop-b-failed'],
      ])
    } finally { await manager.delete(workflow.id) }
  })

  it('reruns only the selected disjoint loop through the shared recursive scheduler', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'continue' })
    const agent = (id: string) => ({ id, type: 'agent', data: { title: id, agent: 'hermes', input: id } })
    const workflow = manager.create({
      name: `Rerun disjoint loop ${Date.now()}`, profile: 'default',
      nodes: ['a-h', 'a-l', 'b-h', 'b-l'].map(agent), edges: [
        { id: 'a-forward', source: 'a-h', target: 'a-l' },
        { id: 'a-retry', source: 'a-l', target: 'a-h', data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } } },
        { id: 'b-forward', source: 'b-h', target: 'b-l' },
        { id: 'b-retry', source: 'b-l', target: 'b-h', data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } } },
      ],
    })
    try {
      const fresh = await manager.runNow(workflow.id)
      expect(fresh.run.status).toBe('completed')
      chatRunMock.runAndWait.mockClear()
      const rerun = await manager.rerunFromNode(workflow.id, fresh.run.id, 'a-h')
      expect({ status: rerun.run.status, error: rerun.run.error }).toEqual({ status: 'completed', error: null })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(4)
      const scoped = rerun.nodeSessions.filter(session => session.execution_id.includes('@rerun:'))
      expect(scoped.map(session => session.node_id)).toEqual(['a-h', 'a-l', 'a-h', 'a-l'])
      expect(rerun.nodeSessions.filter(session => session.node_id.startsWith('b-'))).toHaveLength(4)
    } finally { await manager.delete(workflow.id) }
  })

  it('reruns conditional routes with the same skipped propagation as a fresh run', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRunEdgeEvaluations } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockImplementation(async (request: { session_id: string; input: string }) => {
      const output = request.input.includes('source') ? 'use-matched' : 'done'
      chatRunMock.sessionOutputs.set(request.session_id, output)
      return { ok: true, output }
    })
    const workflow = manager.create({
      name: `Rerun conditional scheduler ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'source', type: 'agent', data: { title: 'Source', agent: 'hermes', input: 'source' } },
        { id: 'matched', type: 'agent', data: { title: 'Matched', agent: 'hermes', input: 'matched' } },
        { id: 'unmatched', type: 'agent', data: { title: 'Unmatched', agent: 'hermes', input: 'unmatched' } },
      ], edges: [
        { id: 'source-matched', source: 'source', target: 'matched', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'equals', value: 'use-matched' } } } },
        { id: 'source-unmatched', source: 'source', target: 'unmatched', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'equals', value: 'use-unmatched' } } } },
      ],
    })
    try {
      const fresh = await manager.runNow(workflow.id)
      expect(fresh.nodeSessions.map(session => session.node_id)).toEqual(['source', 'matched'])
      chatRunMock.runAndWait.mockClear()
      const rerun = await manager.rerunFromNode(workflow.id, fresh.run.id, 'source')
      expect(rerun.run.status).toBe('completed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(2)
      expect(rerun.nodeSessions.map(session => session.node_id)).toEqual(['source', 'matched', 'source', 'matched'])
      expect(rerun.nodeSessions.filter(session => session.execution_id.includes('@rerun:')).map(session => session.node_id)).toEqual(['source', 'matched'])
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.unmatched).toBe('skipped')
      expect(listWorkflowRunEdgeEvaluations(fresh.run.id).slice(-2).map(item => [item.edge_id, item.status])).toEqual([
        ['source-matched', 'taken'], ['source-unmatched', 'not_taken'],
      ])
    } finally { await manager.delete(workflow.id) }
  })

  it('does not let late rerun completion override cancellation or dispatch downstream', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRunEdgeEvaluations, listWorkflowRunNodeSessions } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockResolvedValue({ ok: true, output: 'fresh' })
    chatRunMock.abortSession.mockReset().mockResolvedValue(undefined)
    const workflow = manager.create({
      name: `Late rerun cancel ${Date.now()}`, profile: 'default',
      nodes: [{ id: 'a', type: 'agent', data: { title: 'A', agent: 'hermes', input: 'a' } }, { id: 'b', type: 'agent', data: { title: 'B', agent: 'hermes', input: 'b' } }],
      edges: [{ id: 'a-b', source: 'a', target: 'b' }],
    })
    try {
      const fresh = await manager.runNow(workflow.id)
      const freshEvidenceCount = listWorkflowRunEdgeEvaluations(fresh.run.id).length
      let release!: (value: any) => void
      chatRunMock.runAndWait.mockReset().mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      const rerunPromise = manager.rerunFromNode(workflow.id, fresh.run.id, 'a')
      await vi.waitFor(() => expect(manager.getRuntimeStatus(workflow.id).status).toBe('running'))
      await manager.stopRun(workflow.id, fresh.run.id, 'operator canceled rerun')
      release({ ok: true, output: 'late success' })
      const rerun = await rerunPromise
      expect(rerun.run.status).toBe('canceled')
      const history = listWorkflowRunNodeSessions(fresh.run.id)
      expect(history.map(item => item.node_id)).toEqual(['a', 'b', 'a'])
      expect(history.slice(0, 2).map(item => item.status)).toEqual(['completed', 'completed'])
      expect(history[2]).toMatchObject({ node_id: 'a', status: 'canceled' })
      expect(history[2].execution_id).toContain('@rerun:')
      expect(listWorkflowRunEdgeEvaluations(fresh.run.id)).toHaveLength(freshEvidenceCount)
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
    } finally { await manager.delete(workflow.id) }
  })

  it('reruns failure and always routes through the shared scheduler', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRunEdgeEvaluations } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    let failSource = false
    chatRunMock.runAndWait.mockReset().mockImplementation(async (request: { input: string }) => (
      failSource && request.input.includes('source') ? { ok: false, error: 'source failed' } : { ok: true, output: 'done' }
    ))
    const workflow = manager.create({
      name: `Rerun failure routes ${Date.now()}`, profile: 'default',
      nodes: ['source', 'success', 'failure', 'always'].map(id => ({ id, type: 'agent', data: { title: id, agent: 'hermes', input: id } })),
      edges: [
        { id: 'success-edge', source: 'source', target: 'success' },
        { id: 'failure-edge', source: 'source', target: 'failure', data: { orchestration: { route: 'failure' } } },
        { id: 'always-edge', source: 'source', target: 'always', data: { orchestration: { route: 'always' } } },
      ],
    })
    try {
      const fresh = await manager.runNow(workflow.id)
      failSource = true
      chatRunMock.runAndWait.mockClear()
      const rerun = await manager.rerunFromNode(workflow.id, fresh.run.id, 'source')
      expect(rerun.run.status).toBe('failed')
      expect(rerun.nodeSessions.filter(session => session.execution_id.includes('@rerun:')).map(session => session.node_id).sort()).toEqual(['always', 'failure', 'source'])
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(3)
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.success).toBe('skipped')
      expect(listWorkflowRunEdgeEvaluations(fresh.run.id).slice(-3).map(item => [item.edge_id, item.status])).toEqual([
        ['success-edge', 'not_taken'], ['failure-edge', 'taken'], ['always-edge', 'taken'],
      ])
    } finally { await manager.delete(workflow.id) }
  })

  it('reruns incomplete external upstream dependencies for downstream joins', async () => {
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    const {
      createWorkflowRun,
      createWorkflowRunNodeSession,
      listWorkflowRunNodeSessions,
      updateWorkflowRun,
    } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset()
    chatRunMock.abortSession.mockReset()
    chatRunMock.runAndWait.mockResolvedValue({ ok: true, output: 'done' })

    const snapshotNodes = [
      { id: 'entry-a', type: 'agent', data: { title: 'Entry A', agent: 'hermes', input: 'a' } },
      { id: 'entry-b', type: 'agent', data: { title: 'Entry B', agent: 'hermes', input: 'b' } },
      { id: 'join', type: 'agent', data: { title: 'Join', agent: 'hermes', input: 'join' } },
    ]
    const snapshotEdges = [
      { id: 'entry-a-join', source: 'entry-a', target: 'join' },
      { id: 'entry-b-join', source: 'entry-b', target: 'join' },
    ]
    const workflow = manager.create({
      name: `Rerun dependencies ${Date.now()}`,
      profile: 'default',
      nodes: snapshotNodes,
      edges: snapshotEdges,
    })
    const run = createWorkflowRun({
      workflow_id: workflow.id,
      profile: 'default',
      status: 'running',
      snapshot_nodes: snapshotNodes,
      snapshot_edges: snapshotEdges,
      started_at: Date.now(),
    })
    for (const [sequence, nodeId] of ['entry-a', 'entry-b', 'join'].entries()) {
      createWorkflowRunNodeSession({
        run_id: run.id,
        workflow_id: workflow.id,
        node_id: nodeId,
        session_id: `canceled-${nodeId}`,
        profile: 'default',
        agent: 'hermes',
        status: 'canceled',
        sequence,
        started_at: Date.now(),
        finished_at: Date.now(),
      })
    }
    updateWorkflowRun(run.id, { status: 'canceled', finished_at: Date.now() })

    try {
      await expect(manager.rerunFromNode(workflow.id, run.id, 'entry-a')).resolves.toMatchObject({
        run: { status: 'completed' },
      })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(3)
      expect(listWorkflowRunNodeSessions(run.id).map(session => [session.node_id, session.status])).toEqual([
        ['entry-a', 'canceled'], ['entry-b', 'canceled'], ['join', 'canceled'],
        ['entry-a', 'completed'], ['entry-b', 'completed'], ['join', 'completed'],
      ])
    } finally {
      await manager.delete(workflow.id)
    }
  })
  it('recovers every active run after restart without the UI pagination limit', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const {
      createWorkflowRun, createWorkflowRunNodeSession, getWorkflowRun, listAllWorkflowRuns,
    } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    chatRunMock.abortSession.mockReset().mockResolvedValue(undefined)
    const manager = new WorkflowManager()
    const workflow = manager.create({ name: `Recovery ${Date.now()}`, profile: 'default', nodes: [], edges: [] })
    const activeRuns = Array.from({ length: 501 }, (_, index) => createWorkflowRun({
      workflow_id: workflow.id, status: index % 2 === 0 ? 'running' : 'queued',
      snapshot_nodes: [{ id: `node-${index}`, type: 'agent', data: { agent: 'hermes', input: 'work' } }],
      snapshot_edges: [], started_at: Date.now() - index,
    }))
    for (const [index, run] of activeRuns.entries()) {
      createWorkflowRunNodeSession({
        run_id: run.id, workflow_id: workflow.id, node_id: `node-${index}`,
        execution_id: `node-${index}`, session_id: `session-${index}`, status: 'running',
      })
    }
    try {
      expect(listAllWorkflowRuns(workflow.id)).toHaveLength(501)
      const recovered = await manager.recoverActiveRuns(workflow.id)
      expect(recovered).toEqual({ runs: 501, sessions: 501 })
      expect(activeRuns.every(run => getWorkflowRun(run.id)?.status === 'failed')).toBe(true)
      expect(chatRunMock.abortSession).toHaveBeenCalledTimes(501)
      expect(chatRunMock.abortSession).toHaveBeenCalledWith('session-500', expect.stringContaining('server restarted'))
    } finally { await manager.delete(workflow.id) }
  })

  it('persists restart terminal state before aborting surviving runners and never aborts completed sessions', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const {
      createWorkflowRun, createWorkflowRunNodeSession, getWorkflowRun, listWorkflowRunNodeSessions,
    } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    const workflow = manager.create({ name: `Recovery ordering ${Date.now()}`, profile: 'default', nodes: [], edges: [] })
    const run = createWorkflowRun({
      workflow_id: workflow.id, status: 'running', snapshot_nodes: [], snapshot_edges: [],
      compiled_loops: [{ id: 'loop:active', bodyNodeIds: ['running'], feedbackEdgeId: 'feedback', headerNodeId: 'running', latchNodeId: 'running', maxIterations: 3, exitNodeIds: [], parentLoopId: null }],
    })
    createWorkflowRunNodeSession({ run_id: run.id, workflow_id: workflow.id, node_id: 'running', execution_id: 'running@loop:active:0', iteration_path: [{ loopId: 'loop:active', iteration: 0 }], session_id: 'shared-session', status: 'running' })
    createWorkflowRunNodeSession({ run_id: run.id, workflow_id: workflow.id, node_id: 'queued', session_id: 'shared-session', status: 'queued' })
    createWorkflowRunNodeSession({ run_id: run.id, workflow_id: workflow.id, node_id: 'done', session_id: 'completed-session', status: 'completed' })
    chatRunMock.abortSession.mockReset().mockImplementation(async () => {
      expect(getWorkflowRun(run.id)?.status).toBe('failed')
      expect(listWorkflowRunNodeSessions(run.id).filter(item => item.status === 'running' || item.status === 'queued')).toEqual([])
    })
    try {
      await expect(manager.recoverActiveRuns(workflow.id)).resolves.toEqual({ runs: 1, sessions: 1 })
      const { listWorkflowRunLoopEpochs } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
      expect(listWorkflowRunLoopEpochs(run.id)).toEqual([expect.objectContaining({
        loop_id: 'loop:active', iteration: 0, status: 'failed', exit_reason: expect.stringContaining('server restarted'),
      })])
      expect(chatRunMock.abortSession).toHaveBeenCalledTimes(1)
      expect(chatRunMock.abortSession).not.toHaveBeenCalledWith('completed-session', expect.anything())
    } finally { await manager.delete(workflow.id) }
  })

  it('keeps recovered and canceled terminal state authoritative against late completion', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const {
      createWorkflowRun, createWorkflowRunNodeSession, getWorkflowRun, listWorkflowRunNodeSessions,
      updateWorkflowRun, updateWorkflowRunNodeSession,
    } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    const workflow = manager.create({ name: `Late completion ${Date.now()}`, profile: 'default', nodes: [], edges: [] })
    const run = createWorkflowRun({ workflow_id: workflow.id, status: 'running', snapshot_nodes: [], snapshot_edges: [] })
    const session = createWorkflowRunNodeSession({ run_id: run.id, workflow_id: workflow.id, node_id: 'agent', session_id: 'late-session', status: 'running' })
    chatRunMock.abortSession.mockReset().mockResolvedValue(undefined)
    try {
      await manager.recoverActiveRuns(workflow.id)
      updateWorkflowRun(run.id, { status: 'completed', finished_at: Date.now(), error: null })
      updateWorkflowRunNodeSession(session.id, { status: 'completed', finished_at: Date.now(), error: null })
      expect(getWorkflowRun(run.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('server restarted') })
      expect(listWorkflowRunNodeSessions(run.id)[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('server restarted') })
    } finally { await manager.delete(workflow.id) }
  })

  it('stopRun preserves terminal node evidence and cancels only active executions', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { createWorkflowRun, createWorkflowRunNodeSession, listWorkflowRunNodeSessions } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    const workflow = manager.create({ name: `Stop terminal authority ${Date.now()}`, profile: 'default', nodes: [], edges: [] })
    const run = createWorkflowRun({ workflow_id: workflow.id, status: 'running', snapshot_nodes: [], snapshot_edges: [] })
    createWorkflowRunNodeSession({ run_id: run.id, workflow_id: workflow.id, node_id: 'done', session_id: 'done-session', status: 'completed', sequence: 0 })
    createWorkflowRunNodeSession({ run_id: run.id, workflow_id: workflow.id, node_id: 'rejected', session_id: 'rejected-session', status: 'approval_rejected', sequence: 1, error: 'rejected' })
    createWorkflowRunNodeSession({ run_id: run.id, workflow_id: workflow.id, node_id: 'active', session_id: 'active-session', status: 'running', sequence: 2 })
    chatRunMock.abortSession.mockReset().mockResolvedValue(undefined)
    try {
      await manager.stopRun(workflow.id, run.id, 'operator stopped')
      expect(listWorkflowRunNodeSessions(run.id).map(item => [item.node_id, item.status, item.error])).toEqual([
        ['done', 'completed', null],
        ['rejected', 'approval_rejected', 'rejected'],
        ['active', 'canceled', 'operator stopped'],
      ])
      expect(chatRunMock.abortSession).toHaveBeenCalledTimes(1)
      expect(chatRunMock.abortSession).toHaveBeenCalledWith('active-session', 'operator stopped')
    } finally { await manager.delete(workflow.id) }
  })

  it('persists canceled run and sessions before awaiting runner abort', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { createWorkflowRun, createWorkflowRunNodeSession, getWorkflowRun, listWorkflowRunNodeSessions } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    const workflow = manager.create({ name: `Stop ordering ${Date.now()}`, profile: 'default', nodes: [], edges: [] })
    const run = createWorkflowRun({ workflow_id: workflow.id, status: 'running', snapshot_nodes: [], snapshot_edges: [] })
    createWorkflowRunNodeSession({ run_id: run.id, workflow_id: workflow.id, node_id: 'agent', session_id: 'stop-session', status: 'running' })
    chatRunMock.abortSession.mockReset().mockImplementation(async () => {
      expect(getWorkflowRun(run.id)?.status).toBe('canceled')
      expect(listWorkflowRunNodeSessions(run.id)[0].status).toBe('canceled')
    })
    try {
      await manager.stopRun(workflow.id, run.id)
      expect(chatRunMock.abortSession).toHaveBeenCalledTimes(1)
    } finally { await manager.delete(workflow.id) }
  })

  it('deletes workflow runs beyond the public 500-run page', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { createWorkflowRun, getWorkflowRun, listAllWorkflowRuns } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    const workflow = manager.create({ name: `Delete all ${Date.now()}`, profile: 'default', nodes: [], edges: [] })
    const runs = Array.from({ length: 501 }, () => createWorkflowRun({ workflow_id: workflow.id, status: 'completed', snapshot_nodes: [], snapshot_edges: [] }))
    expect(listAllWorkflowRuns(workflow.id)).toHaveLength(501)
    await expect(manager.delete(workflow.id)).resolves.toBe(true)
    expect(runs.every(run => getWorkflowRun(run.id) === null)).toBe(true)
  })

  it('rejects orphan Node, Edge, and Loop evidence for a missing Run', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { createWorkflowRunEdgeEvaluation, createWorkflowRunLoopEpoch, createWorkflowRunNodeSession } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    initAllStores()
    const missing = `missing-${Date.now()}`
    expect(() => createWorkflowRunNodeSession({ run_id: missing, workflow_id: 'wf', node_id: 'n', session_id: 's' })).toThrow('missing workflow run')
    expect(() => createWorkflowRunEdgeEvaluation({
      run_id: missing, workflow_id: 'wf', edge_id: 'e', source_node_id: 'a', target_node_id: 'b',
      source_outcome: 'success', status: 'taken', route: 'success', reason: null, sequence: 0,
      orchestration: { route: 'success' }, condition_evaluation: null,
    })).toThrow('missing workflow run')
    expect(() => createWorkflowRunLoopEpoch({
      run_id: missing, workflow_id: 'wf', loop_id: 'l', iteration: 0, iteration_path: [],
      status: 'completed', exit_reason: null, sequence: 0, started_at: 1, finished_at: 2,
    })).toThrow('missing workflow run')
  })

  it('rejects late node execution creation after a run is terminal', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { createWorkflowRun, createWorkflowRunNodeSession, updateWorkflowRun } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    initAllStores()
    const run = createWorkflowRun({ workflow_id: `terminal-node-${Date.now()}`, status: 'running' })
    updateWorkflowRun(run.id, { status: 'canceled', finished_at: Date.now(), error: 'stopped' })
    expect(() => createWorkflowRunNodeSession({
      run_id: run.id, workflow_id: run.workflow_id, node_id: 'late', execution_id: 'late', session_id: 'late-session', status: 'running',
    })).toThrow('cannot create node execution for terminal workflow run')
  })

  it('rejects late edge and loop evidence after a run is terminal', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const {
      createWorkflowRun, createWorkflowRunEdgeEvaluation, createWorkflowRunLoopEpoch, updateWorkflowRun,
    } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    initAllStores()
    const run = createWorkflowRun({ workflow_id: `terminal-evidence-${Date.now()}`, status: 'running' })
    updateWorkflowRun(run.id, { status: 'failed', finished_at: Date.now(), error: 'terminal' })
    expect(() => createWorkflowRunEdgeEvaluation({
      run_id: run.id, workflow_id: run.workflow_id, edge_id: 'late-edge', source_node_id: 'a', target_node_id: 'b',
      source_outcome: 'success', status: 'taken', route: 'success', reason: null, sequence: 1,
      orchestration: { route: 'success' }, condition_evaluation: null,
    })).toThrow('cannot append edge evidence to terminal workflow run')
    expect(() => createWorkflowRunLoopEpoch({
      run_id: run.id, workflow_id: run.workflow_id, loop_id: 'late-loop', iteration: 0, iteration_path: [],
      status: 'completed', exit_reason: 'late', sequence: 2, started_at: Date.now(), finished_at: Date.now(),
    })).toThrow('cannot append loop evidence to terminal workflow run')
  })

  it('does not let a late successful node completion override stopRun', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRunEdgeEvaluations, listWorkflowRunNodeSessions } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    let release!: (value: any) => void
    chatRunMock.runAndWait.mockReset().mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    chatRunMock.abortSession.mockReset().mockResolvedValue(undefined)
    const workflow = manager.create({
      name: `Late success stop ${Date.now()}`, profile: 'default',
      nodes: [{ id: 'a', type: 'agent', data: { title: 'A', agent: 'hermes', input: 'a' } }, { id: 'b', type: 'agent', data: { title: 'B', agent: 'hermes', input: 'b' } }], edges: [{ id: 'a-b', source: 'a', target: 'b' }],
    })
    try {
      const runPromise = manager.runNow(workflow.id)
      await vi.waitFor(() => expect(manager.getRuntimeStatus(workflow.id).status).toBe('running'))
      const runId = manager.getRuntimeStatus(workflow.id).runId!
      await manager.stopRun(workflow.id, runId)
      release({ ok: true, output: 'late success' })
      const result = await runPromise
      expect(result.run.status).toBe('canceled')
      expect(listWorkflowRunNodeSessions(runId).map(item => item.status)).toEqual(['canceled'])
      expect(listWorkflowRunEdgeEvaluations(runId)).toEqual([])
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
    } finally { await manager.delete(workflow.id) }
  })


  it('starts an any-join inside a loop after the first taken edge while a sibling source is still running', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    let releaseSlow!: () => void
    const slow = new Promise<{ ok: true; output: string }>(resolve => { releaseSlow = () => resolve({ ok: true, output: 'slow-done' }) })
    chatRunMock.runAndWait.mockReset().mockImplementation(async (request: { session_id: string; input: string }) => {
      if (request.input.includes('slow')) return slow
      const output = request.input.includes('latch') ? 'stop' : 'done'
      chatRunMock.sessionOutputs.set(request.session_id, output)
      return { ok: true, output }
    })
    const workflow = manager.create({
      name: `Loop completion driven any ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'fast', type: 'agent', data: { title: 'Fast', agent: 'hermes', input: 'fast' } },
        { id: 'slow', type: 'agent', data: { title: 'Slow', agent: 'hermes', input: 'slow' } },
        { id: 'join', type: 'agent', data: { title: 'Join', agent: 'hermes', input: 'join', orchestration: { join: 'any' } } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ],
      edges: [
        { id: 'header-fast', source: 'header', target: 'fast' },
        { id: 'header-slow', source: 'header', target: 'slow' },
        { id: 'fast-join', source: 'fast', target: 'join' },
        { id: 'slow-join', source: 'slow', target: 'join' },
        { id: 'join-latch', source: 'join', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 1 } } } },
      ],
    })
    try {
      const runPromise = manager.runNow(workflow.id)
      await vi.waitFor(() => expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.slow).toBe('running'))
      await vi.waitFor(() => expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.join).toBe('completed'))
      await vi.waitFor(() => expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.latch).toBe('completed'))
      let settled = false
      void runPromise.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      releaseSlow()
      await expect(runPromise).resolves.toMatchObject({ run: { status: 'completed' } })
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(5)
    } finally { releaseSlow?.(); await manager.delete(workflow.id) }
  })

  it('does not take feedback or start another iteration when the loop latch is skipped', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRunEdgeEvaluations, listWorkflowRunLoopEpochs } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    chatRunMock.runAndWait.mockReset().mockImplementation(async (request: { session_id: string }) => {
      chatRunMock.sessionOutputs.set(request.session_id, 'stop')
      return { ok: true, output: 'stop' }
    })
    const workflow = manager.create({
      name: `Skipped loop latch ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ],
      edges: [
        { id: 'conditional-latch', source: 'header', target: 'latch', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'equals', value: 'continue' } } } },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 3 } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('completed')
      expect(chatRunMock.runAndWait).toHaveBeenCalledTimes(1)
      expect(result.nodeSessions.map(session => session.node_id)).toEqual(['header'])
      expect(manager.getRuntimeStatus(workflow.id).nodeStatuses.latch).toBe('skipped')
      expect(listWorkflowRunEdgeEvaluations(result.run.id).filter(item => item.edge_id === 'retry')).toEqual([
        expect.objectContaining({ source_outcome: 'skipped', status: 'not_taken', reason: 'route_not_matched' }),
      ])
      expect(listWorkflowRunLoopEpochs(result.run.id)).toEqual([
        expect.objectContaining({ iteration: 0, status: 'completed', exit_reason: 'route_not_matched' }),
      ])
    } finally { await manager.delete(workflow.id) }
  })

  it('carries the taken feedback output and evidence id into the next header execution', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { listWorkflowRunEdgeEvaluations, listWorkflowRunNodeSessions } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
    initAllStores()
    const manager = new WorkflowManager()
    const requests: Array<{ input: string }> = []
    let call = 0
    chatRunMock.runAndWait.mockReset().mockImplementation(async (request: { session_id: string; input: string }) => {
      requests.push({ input: request.input })
      call += 1
      const output = call === 2 ? 'feedback-payload' : `output-${call}`
      chatRunMock.sessionOutputs.set(request.session_id, output)
      return { ok: true, output }
    })
    const workflow = manager.create({
      name: `Feedback provenance ${Date.now()}`, profile: 'default',
      nodes: [
        { id: 'header', type: 'agent', data: { title: 'Header', agent: 'hermes', input: 'header' } },
        { id: 'latch', type: 'agent', data: { title: 'Latch', agent: 'hermes', input: 'latch' } },
      ],
      edges: [
        { id: 'forward', source: 'header', target: 'latch' },
        { id: 'retry', source: 'latch', target: 'header', data: { orchestration: { route: 'success', feedback: { maxIterations: 2 } } } },
      ],
    })
    try {
      const result = await manager.runNow(workflow.id)
      expect(result.run.status).toBe('completed')
      expect(requests).toHaveLength(4)
      expect(requests[2].input).toContain('feedback-payload')
      const feedbackEvidence = listWorkflowRunEdgeEvaluations(result.run.id).filter(item => item.edge_id === 'retry')
      expect(feedbackEvidence.map(item => item.status)).toEqual(['taken', 'not_taken'])
      const secondHeader = listWorkflowRunNodeSessions(result.run.id).find(session => session.execution_id === 'header@loop:retry:1')!
      expect(secondHeader.consumed_edge_evaluation_ids).toEqual([feedbackEvidence[0].id])
      expect(feedbackEvidence[0].sequence).toBeLessThan(secondHeader.sequence)
    } finally { await manager.delete(workflow.id) }
  })

})
