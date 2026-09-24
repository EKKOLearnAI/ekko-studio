import { beforeEach, describe, expect, it, vi } from 'vitest'

const managerMock = vi.hoisted(() => ({
  get: vi.fn(),
  deleteRun: vi.fn(),
  rerunFromNode: vi.fn(),
  runNow: vi.fn(),
  stopRun: vi.fn(),
  approveNode: vi.fn(),
  create: vi.fn(),
}))
const listWorkflowRunsWithEvidenceMock = vi.hoisted(() => vi.fn())
const getWorkflowRunWithEvidenceMock = vi.hoisted(() => vi.fn())
const preflightExecutionMock = vi.hoisted(() => vi.fn())
const preflightRerunMock = vi.hoisted(() => vi.fn())
const skillDependenciesMock = vi.hoisted(() => vi.fn())
const listWorkflowRunNodeSessionsMock = vi.hoisted(() => vi.fn())
const listWorkflowRunEdgeEvaluationsMock = vi.hoisted(() => vi.fn())
const listWorkflowRunLoopEpochsMock = vi.hoisted(() => vi.fn())
const listUserProfilesMock = vi.hoisted(() => vi.fn())
const getAvailableModelGroupsMock = vi.hoisted(() => vi.fn())
const assertImportCapabilitiesMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/modules/studio/services/workflow/manager', async importOriginal => {
  const actual = await importOriginal<typeof import('../../packages/server/src/modules/studio/services/workflow/manager')>()
  return {
    ...actual,
    getWorkflowManager: () => managerMock,
    preflightWorkflowExecutionDefinition: preflightExecutionMock,
    preflightWorkflowRerunDefinition: preflightRerunMock,
    assertWorkflowNodeSkillDependencies: skillDependenciesMock,
  }
})

vi.mock('../../packages/server/src/modules/studio/public/users', () => ({
  listUserProfiles: listUserProfilesMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/workflow/import-capabilities', async importOriginal => {
  const actual = await importOriginal<typeof import('../../packages/server/src/modules/studio/services/workflow/import-capabilities')>()
  return {
    ...actual,
    assertWorkflowImportCapabilities: assertImportCapabilitiesMock,
    workflowImportEnvironmentRevision: () => 'rev-1',
  }
})


vi.mock('../../packages/server/src/modules/studio/public/workflow-runtime', () => ({
  getWorkflowAvailableModelGroups: getAvailableModelGroupsMock,
}))


vi.mock('../../packages/server/src/modules/studio/repositories/workflow-run-store', () => ({
  listWorkflowRunNodeSessions: listWorkflowRunNodeSessionsMock,
  listWorkflowRunEdgeEvaluations: listWorkflowRunEdgeEvaluationsMock,
  listWorkflowRunLoopEpochs: listWorkflowRunLoopEpochsMock,
  listWorkflowRunsWithEvidence: listWorkflowRunsWithEvidenceMock,
  getWorkflowRunWithEvidence: getWorkflowRunWithEvidenceMock,
}))

function ctx(overrides: Record<string, any> = {}) {
  return {
    get: () => '',
    params: {},
    query: {},
    request: { body: {} },
    state: {},
    status: 200,
    body: undefined,
    ...overrides,
  } as any
}

describe('workflow controller', () => {
  beforeEach(() => {
    managerMock.get.mockReset()
    managerMock.deleteRun.mockReset()
    managerMock.rerunFromNode.mockReset()
    managerMock.runNow.mockReset()
    managerMock.stopRun.mockReset()
    managerMock.approveNode.mockReset()
    managerMock.create.mockReset()
    listWorkflowRunNodeSessionsMock.mockReset()
    listWorkflowRunEdgeEvaluationsMock.mockReset()
    listWorkflowRunLoopEpochsMock.mockReset()
    listWorkflowRunLoopEpochsMock.mockReturnValue([])
    listWorkflowRunsWithEvidenceMock.mockReset()
    getWorkflowRunWithEvidenceMock.mockReset()
    preflightExecutionMock.mockReset().mockResolvedValue({ compiled: { nodes: [], edges: [], loops: [], startNodeIds: [] }, activeNodeIds: new Set(), activeNodes: [] })
    preflightRerunMock.mockReset().mockResolvedValue({ compiled: { nodes: [], edges: [], loops: [], startNodeIds: [] }, activeNodeIds: new Set(), activeNodes: [] })
    skillDependenciesMock.mockReset().mockResolvedValue(undefined)
    listUserProfilesMock.mockReset()
    listUserProfilesMock.mockReturnValue([])
    getAvailableModelGroupsMock.mockReset().mockResolvedValue([])
    assertImportCapabilitiesMock.mockReset()
  })

  it('exports, previews, and confirms a portable workflow copy', async () => {
    const source = {
      id: 'workflow-1', name: 'Portable', profile: 'default', workspace: '/private',
      nodes: [{ id: 'n1', type: 'agent', position: { x: 0, y: 0 }, data: { title: 'One', agent: 'hermes', input: 'go' } }],
      edges: [], viewport: null, created_at: 1, updated_at: 2,
    }
    managerMock.get.mockReturnValue(source)
    managerMock.create.mockImplementation((input: any) => ({ id: 'workflow-copy', workspace: '/generated', created_at: 3, updated_at: 3, ...input }))
    const mod = await import('../../packages/server/src/modules/studio/controllers/workflows')
    const exportCtx = ctx({ params: { id: 'workflow-1' }, state: { user: { id: 'u1', role: 'super_admin' } } })
    await mod.exportDefinition(exportCtx)
    expect(exportCtx.body).toMatchObject({ format: 'hermes-studio.workflow', version: 1, definition: { name: 'Portable' } })
    expect(JSON.stringify(exportCtx.body)).not.toContain('/private')

    const previewCtx = ctx({ request: { body: { document: JSON.stringify(exportCtx.body), profile: 'default' } }, state: { user: { id: 'u1', role: 'super_admin' } } })
    await mod.previewImport(previewCtx)
    expect(previewCtx.body).toMatchObject({ ok: true, preview: { summary: { name: 'Portable', nodes: 1, edges: 0 } } })

    const confirmCtx = ctx({ request: { body: { token: previewCtx.body.preview.token, profile: 'default' } }, state: { user: { id: 'u1', role: 'super_admin' } } })
    await mod.confirmImport(confirmCtx)
    expect(confirmCtx.status).toBe(201)
    expect(managerMock.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Portable', profile: 'default' }))
    expect(confirmCtx.body).toMatchObject({ ok: true, workflow: { id: 'workflow-copy', name: 'Portable' } })
  })


  it('imports legacy v1 workflows without source-environment capability or skill validation', async () => {
    const legacy = {
      format: 'hermes-studio.workflow', version: 1, definition: {
        name: 'Cross environment',
        nodes: [{ id: 'n1', type: 'agent', position: { x: 0, y: 0 }, data: {
          title: 'One', agent: 'hermes', provider: 'custom:source-only', model: 'source-model',
          apiMode: 'chat_completions', reasoningEffort: 'max', input: 'go', skills: ['source-only-skill'],
        } }],
        edges: [], viewport: null,
      },
    }
    managerMock.create.mockImplementation((input: any) => ({ id: 'workflow-copy', workspace: null, created_at: 3, updated_at: 3, ...input }))
    assertImportCapabilitiesMock.mockImplementation(() => { throw Object.assign(new Error('target capability is unavailable'), { status: 409 }) })
    skillDependenciesMock.mockRejectedValue(Object.assign(new Error('skill unavailable'), { status: 409 }))
    const mod = await import('../../packages/server/src/modules/studio/controllers/workflows')
    const previewCtx = ctx({ request: { body: { document: JSON.stringify(legacy), profile: 'target' } }, state: { user: { id: 'u1', role: 'super_admin' } } })
    await mod.previewImport(previewCtx)
    expect(previewCtx.status).toBe(200)
    expect(previewCtx.body).toMatchObject({ ok: true, preview: { summary: { name: 'Cross environment' } } })

    const confirmCtx = ctx({ request: { body: { token: previewCtx.body.preview.token, profile: 'target' } }, state: { user: { id: 'u1', role: 'super_admin' } } })
    await mod.confirmImport(confirmCtx)
    expect(confirmCtx.status).toBe(201)
    expect(managerMock.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Cross environment', profile: 'target',
      nodes: [expect.objectContaining({ data: expect.objectContaining({ skills: ['source-only-skill'] }) })],
    }))
    const importedData = managerMock.create.mock.calls[0][0].nodes[0].data
    expect(importedData).not.toHaveProperty('provider')
    expect(importedData).not.toHaveProperty('model')
    expect(importedData).not.toHaveProperty('apiMode')
    expect(importedData).not.toHaveProperty('reasoningEffort')
    expect(assertImportCapabilitiesMock).not.toHaveBeenCalled()
    expect(skillDependenciesMock).not.toHaveBeenCalled()
  })

  it('lists run records for a workflow', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default', nodes: [], edges: [] })
    listWorkflowRunsWithEvidenceMock.mockReturnValue([{
      id: 'run-1', workflow_id: 'workflow-1', status: 'completed',
      node_sessions: [{ id: 'node-session-1', node_id: 'node-1', status: 'completed' }],
      edge_evaluations: [{ id: 'edge-eval-1', edge_id: 'edge-1', sequence: 0, status: 'taken' }],
      loop_epochs: [{ id: 'loop-epoch-1', loop_id: 'loop:retry', iteration: 0, status: 'completed' }],
    }])

    const mod = await import('../../packages/server/src/modules/studio/controllers/workflows')
    const c = ctx({ params: { id: 'workflow-1' }, query: { limit: '25' } })

    await mod.listRuns(c)

    expect(listWorkflowRunsWithEvidenceMock).toHaveBeenCalledWith('workflow-1', 25)
    expect(c.body).toEqual({
      runs: [{
        id: 'run-1',
        workflow_id: 'workflow-1',
        status: 'completed',
        node_sessions: [{ id: 'node-session-1', node_id: 'node-1', status: 'completed' }],
        edge_evaluations: [{ id: 'edge-eval-1', edge_id: 'edge-1', sequence: 0, status: 'taken' }],
        loop_epochs: [{ id: 'loop-epoch-1', loop_id: 'loop:retry', iteration: 0, status: 'completed' }],
      }],
    })
  })

  it('does not return a partial run history when edge evidence loading fails', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default', nodes: [], edges: [] })
    listWorkflowRunsWithEvidenceMock.mockImplementation(() => { throw new Error('edge evidence read failed') })
    const mod = await import('../../packages/server/src/modules/studio/controllers/workflows')
    const c = ctx({ params: { id: 'workflow-1' } })
    await expect(mod.listRuns(c)).rejects.toThrow('edge evidence read failed')
    expect(c.body).toBeUndefined()
  })

  it('does not return a partial run history when loop epoch loading fails', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default', nodes: [], edges: [] })
    listWorkflowRunsWithEvidenceMock.mockImplementation(() => { throw new Error('loop epoch read failed') })
    const mod = await import('../../packages/server/src/modules/studio/controllers/workflows')
    const c = ctx({ params: { id: 'workflow-1' } })
    await expect(mod.listRuns(c)).rejects.toThrow('loop epoch read failed')
    expect(c.body).toBeUndefined()
  })

  it('rejects invalid Run and Rerun budgets before asynchronous acceptance', async () => {
    const user = { id: 'user-1', role: 'super_admin' }
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default', nodes: [], edges: [] })
    getWorkflowRunWithEvidenceMock.mockReturnValue({
      id: 'run-1', workflow_id: 'workflow-1', profile: 'default', status: 'completed',
      snapshot_nodes: [], snapshot_edges: [], node_sessions: [], edge_evaluations: [], loop_epochs: [],
    })
    const mod = await import('../../packages/server/src/modules/studio/controllers/workflows')

    for (const invalidTimeout of [0, 999, 1_000.5, Number.NaN, 86_400_001, {}, true]) {
      const invalidRun = ctx({ params: { id: 'workflow-1' }, request: { body: { timeout_ms: invalidTimeout } }, state: { user } })
      await mod.runNow(invalidRun)
      expect(invalidRun.status).toBe(400)
      expect(invalidRun.body).toEqual({ error: 'timeout_ms must be an integer from 1000 to 86400000 milliseconds' })
    }

    const invalidRerun = ctx({
      params: { id: 'workflow-1', runId: 'run-1' },
      request: { body: { node_id: 'node-1', timeout_ms: 86_400_001 } },
      state: { user },
    })
    await mod.rerunFromNode(invalidRerun)
    expect(invalidRerun.status).toBe(400)
    expect(invalidRerun.body).toEqual({ error: 'timeout_ms must be an integer from 1000 to 86400000 milliseconds' })
    expect(managerMock.runNow).not.toHaveBeenCalled()
    expect(managerMock.rerunFromNode).not.toHaveBeenCalled()
  })

  it('runs a workflow through the workflow manager', async () => {
    const user = { id: 'user-1', role: 'super_admin' }
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default', nodes: [], edges: [] })
    managerMock.runNow.mockImplementation(async (_id: string, input: any) => { const run = { id: 'run-1', status: 'running' }; input.onAccepted?.(run); return { run: { ...run, status: 'completed' }, nodeSessions: [] } })

    const mod = await import('../../packages/server/src/modules/studio/controllers/workflows')
    const c = ctx({
      params: { id: 'workflow-1' },
      request: { body: { start_node_ids: ['node-1', 12, 'node-2'], input: 'go', timeout_ms: '1000' } },
      state: { user },
    })

    await mod.runNow(c)

    expect(managerMock.runNow).toHaveBeenCalledWith('workflow-1', expect.objectContaining({
      profile: 'default',
      user,
      startNodeIds: ['node-1', 'node-2'],
      input: 'go',
      timeoutMs: 1000,
      onAccepted: expect.any(Function),
    }))
    expect(c.status).toBe(202)
    expect(c.body).toEqual({ ok: true, status: 'accepted' })
  })


  it('fails closed when a fresh execution resolves before durable acceptance', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default', nodes: [], edges: [] })
    managerMock.runNow.mockResolvedValue({ run: { id: 'run-1', status: 'completed' }, nodeSessions: [] })
    const mod = await import('../../packages/server/src/modules/studio/controllers/workflows')
    const c = ctx({ params: { id: 'workflow-1' } })

    await mod.runNow(c)

    expect(c.status).toBe(500)
    expect(c.body).toEqual({ error: 'workflow execution completed before durable acceptance' })
  })

  it('returns a fresh execution failure instead of reporting acceptance', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default', nodes: [], edges: [] })
    managerMock.runNow.mockRejectedValue(new Error('workflow run persistence failed'))
    const mod = await import('../../packages/server/src/modules/studio/controllers/workflows')
    const c = ctx({ params: { id: 'workflow-1' } })

    await mod.runNow(c)

    expect(c.status).toBe(400)
    expect(c.body).toEqual({ error: 'workflow run persistence failed' })
  })

  it('returns one run detail with the same Node, Edge, and Loop evidence contract', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default', nodes: [], edges: [] })
    getWorkflowRunWithEvidenceMock.mockReturnValue({
      id: 'run-1', workflow_id: 'workflow-1', status: 'completed',
      node_sessions: [{ id: 'node-session-1', sequence: 1 }],
      edge_evaluations: [{ id: 'edge-eval-1', sequence: 2 }],
      loop_epochs: [{ id: 'loop-epoch-1', sequence: 3 }],
    })
    const mod = await import('../../packages/server/src/modules/studio/controllers/workflows')
    const c = ctx({ params: { id: 'workflow-1', runId: 'run-1' } })
    await mod.getRun(c)
    expect(c.body).toEqual({ run: expect.objectContaining({
      id: 'run-1',
      node_sessions: [{ id: 'node-session-1', sequence: 1 }],
      edge_evaluations: [{ id: 'edge-eval-1', sequence: 2 }],
      loop_epochs: [{ id: 'loop-epoch-1', sequence: 3 }],
    }) })
  })

  it('stops a workflow run through the workflow manager', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default', nodes: [], edges: [] })
    managerMock.stopRun.mockResolvedValue({ id: 'run-1', workflow_id: 'workflow-1', status: 'canceled' })

    const mod = await import('../../packages/server/src/modules/studio/controllers/workflows')
    const c = ctx({ params: { id: 'workflow-1', runId: 'run-1' } })

    await mod.stopRun(c)

    expect(managerMock.stopRun).toHaveBeenCalledWith('workflow-1', 'run-1', 'Workflow run canceled by user')
    expect(c.body).toEqual({
      ok: true,
      run: { id: 'run-1', workflow_id: 'workflow-1', status: 'canceled' },
    })
  })

  it('reruns a workflow run from a node through the workflow manager', async () => {
    const user = { id: 'user-1', role: 'super_admin' }
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default', nodes: [], edges: [] })
    managerMock.rerunFromNode.mockImplementation(async (_wid: string, _rid: string, _nid: string, input: any) => { const run = { id: 'run-1', status: 'running' }; input.onAccepted?.(run); return { run: { ...run, status: 'completed' }, nodeSessions: [] } })
    getWorkflowRunWithEvidenceMock.mockReturnValue({ id: 'run-1', workflow_id: 'workflow-1', profile: 'default', status: 'completed', snapshot_nodes: [], snapshot_edges: [], node_sessions: [], edge_evaluations: [], loop_epochs: [] })

    const mod = await import('../../packages/server/src/modules/studio/controllers/workflows')
    const c = ctx({
      params: { id: 'workflow-1', runId: 'run-1' },
      request: { body: { node_id: 'node-2', preserve_start_node: true, timeout_ms: '1000' } },
      state: { user },
    })

    await mod.rerunFromNode(c)

    expect(managerMock.rerunFromNode).toHaveBeenCalledWith('workflow-1', 'run-1', 'node-2', expect.objectContaining({
      profile: 'default',
      user,
      preserveStartNode: true,
      timeoutMs: 1000,
      onAccepted: expect.any(Function),
    }))
    expect(c.status).toBe(202)
    expect(c.body).toEqual({ ok: true, status: 'accepted' })
  })

  it('fails closed when a rerun resolves before durable acceptance', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default', nodes: [], edges: [] })
    managerMock.rerunFromNode.mockResolvedValue({ run: { id: 'run-1', status: 'completed' }, nodeSessions: [] })
    getWorkflowRunWithEvidenceMock.mockReturnValue({ id: 'run-1', workflow_id: 'workflow-1', profile: 'default', status: 'completed', snapshot_nodes: [], snapshot_edges: [], node_sessions: [], edge_evaluations: [], loop_epochs: [] })
    const mod = await import('../../packages/server/src/modules/studio/controllers/workflows')
    const c = ctx({ params: { id: 'workflow-1', runId: 'run-1' }, request: { body: { node_id: 'node-1' } } })

    await mod.rerunFromNode(c)

    expect(c.status).toBe(500)
    expect(c.body).toEqual({ error: 'workflow rerun completed before durable acceptance' })
  })

  it('returns a rerun failure instead of reporting acceptance', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default', nodes: [], edges: [] })
    managerMock.rerunFromNode.mockRejectedValue(new Error('workflow rerun reset failed'))
    getWorkflowRunWithEvidenceMock.mockReturnValue({ id: 'run-1', workflow_id: 'workflow-1', profile: 'default', status: 'completed', snapshot_nodes: [], snapshot_edges: [], node_sessions: [], edge_evaluations: [], loop_epochs: [] })
    const mod = await import('../../packages/server/src/modules/studio/controllers/workflows')
    const c = ctx({ params: { id: 'workflow-1', runId: 'run-1' }, request: { body: { node_id: 'node-1' } } })

    await mod.rerunFromNode(c)

    expect(c.status).toBe(400)
    expect(c.body).toEqual({ error: 'workflow rerun reset failed' })
  })

  it('deletes a workflow run through the workflow manager', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default', nodes: [], edges: [] })
    managerMock.deleteRun.mockResolvedValue(true)

    const mod = await import('../../packages/server/src/modules/studio/controllers/workflows')
    const c = ctx({ params: { id: 'workflow-1', runId: 'run-1' } })

    await mod.deleteRun(c)

    expect(managerMock.deleteRun).toHaveBeenCalledWith('workflow-1', 'run-1')
    expect(c.body).toEqual({ ok: true })
  })

  it('approves a pending workflow node through the workflow manager', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default', nodes: [], edges: [] })
    managerMock.approveNode.mockReturnValue(true)

    const mod = await import('../../packages/server/src/modules/studio/controllers/workflows')
    const c = ctx({
      params: { id: 'workflow-1', runId: 'run-1', nodeId: 'node-1' },
      request: { body: { approved: true } },
    })

    await mod.approveNode(c)

    expect(managerMock.approveNode).toHaveBeenCalledWith('workflow-1', 'run-1', 'node-1', true, undefined)
    expect(managerMock.stopRun).not.toHaveBeenCalled()
    expect(c.body).toEqual({ ok: true })
  })

  it('records a workflow node rejection without stopping the run immediately', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'default', nodes: [], edges: [] })
    managerMock.approveNode.mockReturnValue(true)

    const mod = await import('../../packages/server/src/modules/studio/controllers/workflows')
    const c = ctx({
      params: { id: 'workflow-1', runId: 'run-1', nodeId: 'node-1' },
      request: { body: { approved: false } },
    })

    await mod.approveNode(c)

    expect(managerMock.approveNode).toHaveBeenCalledWith('workflow-1', 'run-1', 'node-1', false, undefined)
    expect(managerMock.stopRun).not.toHaveBeenCalled()
    expect(c.body).toEqual({ ok: true })
  })

  it('rejects workflow runs for unavailable profiles', async () => {
    managerMock.get.mockReturnValue({ id: 'workflow-1', profile: 'secret' })
    listUserProfilesMock.mockReturnValue([{ profile_name: 'default' }])

    const mod = await import('../../packages/server/src/modules/studio/controllers/workflows')
    const c = ctx({
      params: { id: 'workflow-1' },
      state: { user: { id: 'user-1', role: 'user' } },
    })

    await mod.runNow(c)

    expect(c.status).toBe(403)
    expect(managerMock.runNow).not.toHaveBeenCalled()
  })
})
