import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const state = vi.hoisted(() => ({
  db: null as DatabaseSync | null,
  appHome: '',
}))

vi.mock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
  getDb: () => state.db,
  jsonDelete: vi.fn(),
  jsonGet: vi.fn(),
  jsonGetAll: vi.fn(() => ({})),
  jsonSet: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({
  config: {
    appHome: state.appHome,
  },
}))

describe('workflow store', () => {
  let root: string

  beforeEach(async () => {
    vi.resetModules()
    root = mkdtempSync(join(tmpdir(), 'hermes-workflow-store-'))
    state.appHome = join(root, 'home')
    state.db = new DatabaseSync(join(root, 'workflow.db'))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    state.db?.close()
    state.db = null
    rmSync(root, { recursive: true, force: true })
  })

  it('creates workflows with a profile-scoped default workspace', async () => {
    const { createWorkflow, getWorkflow } = await import('../../packages/server/src/modules/studio/repositories/workflow-store')

    const workflow = createWorkflow({
      name: 'Research flow',
      profile: 'research',
      nodes: [{ id: 'agent-1' }],
      edges: [],
      viewport: { x: 12, y: 24, zoom: 0.8 },
    })

    expect(workflow.profile).toBe('research')
    expect(workflow.workspace).toBe(join(state.appHome, 'workflow', 'research', workflow.id))
    expect(existsSync(workflow.workspace!)).toBe(true)
    expect(getWorkflow(workflow.id)).toMatchObject({
      id: workflow.id,
      name: 'Research flow',
      profile: 'research',
      nodes: [{ id: 'agent-1' }],
      viewport: { x: 12, y: 24, zoom: 0.8 },
    })
  })

  it('updates and deletes workflows', async () => {
    const { createWorkflow, deleteWorkflow, getWorkflow, listWorkflows, updateWorkflow } = await import('../../packages/server/src/modules/studio/repositories/workflow-store')
    const workflow = createWorkflow({ name: 'Draft', profile: 'default' })

    const updated = updateWorkflow(workflow.id, {
      name: 'Updated',
      workspace: null,
      nodes: [{ id: 'agent-2' }],
      edges: [{ source: 'agent-1', target: 'agent-2' }],
      viewport: { x: -120, y: 88, zoom: 1.1 },
    })

    expect(updated).toMatchObject({
      id: workflow.id,
      name: 'Updated',
      nodes: [{ id: 'agent-2' }],
      edges: [{ source: 'agent-1', target: 'agent-2' }],
      viewport: { x: -120, y: 88, zoom: 1.1 },
    })
    expect(updated?.workspace).toBe(workflow.workspace)
    expect(listWorkflows('default').map(item => item.id)).toContain(workflow.id)
    expect(deleteWorkflow(workflow.id)).toBe(true)
    expect(getWorkflow(workflow.id)).toBeNull()
  })

  it('persists the requested run deadline and each node start budget', async () => {
    const { createWorkflow } = await import('../../packages/server/src/modules/studio/repositories/workflow-store')
    const {
      createWorkflowRun,
      createWorkflowRunNodeSession,
      getWorkflowRun,
      listWorkflowRunNodeSessions,
    } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const workflow = createWorkflow({ name: 'Budgeted run', profile: 'default' })

    const run = createWorkflowRun({
      workflow_id: workflow.id,
      status: 'running',
      started_at: 1_000,
      requested_timeout_ms: 3_600_000,
      deadline_at: 3_601_000,
    })
    createWorkflowRunNodeSession({
      run_id: run.id,
      workflow_id: workflow.id,
      node_id: 'review',
      session_id: 'session-budget',
      status: 'running',
      started_at: 2_000,
      remaining_timeout_ms_at_start: 3_599_000,
    })

    expect(getWorkflowRun(run.id)).toMatchObject({
      requested_timeout_ms: 3_600_000,
      deadline_at: 3_601_000,
    })
    expect(listWorkflowRunNodeSessions(run.id)).toEqual([
      expect.objectContaining({ remaining_timeout_ms_at_start: 3_599_000 }),
    ])

    const unlimited = createWorkflowRun({ workflow_id: workflow.id, status: 'queued' })
    expect(getWorkflowRun(unlimited.id)).toMatchObject({
      requested_timeout_ms: null,
      deadline_at: null,
    })
  })

  it('lists workflow runs by workflow ordered newest first', async () => {
    const { createWorkflow } = await import('../../packages/server/src/modules/studio/repositories/workflow-store')
    const { createWorkflowRun, listWorkflowRuns, updateWorkflowRun } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const workflow = createWorkflow({ name: 'Runs', profile: 'default' })
    const other = createWorkflow({ name: 'Other', profile: 'default' })

    const first = createWorkflowRun({ workflow_id: workflow.id, status: 'running', started_at: 100 })
    await new Promise(resolve => setTimeout(resolve, 2))
    const second = createWorkflowRun({ workflow_id: workflow.id, status: 'queued', started_at: 200 })
    createWorkflowRun({ workflow_id: other.id, status: 'running' })
    updateWorkflowRun(first.id, { status: 'completed', finished_at: 300 })

    expect(listWorkflowRuns(workflow.id).map(run => run.id)).toEqual([second.id, first.id])
    expect(listWorkflowRuns(workflow.id, 1)).toHaveLength(1)
    expect(listWorkflowRuns(workflow.id)[1]).toMatchObject({
      id: first.id,
      status: 'completed',
      finished_at: 300,
    })
  })

  it('persists the initiating account and resolves cross-Profile nodes to that root', async () => {
    const { createWorkflowRun, createWorkflowRunNodeSession, getWorkflowRun, getWorkflowRunForSession, updateWorkflowRun } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const run = createWorkflowRun({ workflow_id: 'w', profile: 'root', user_id: 42 })
    createWorkflowRunNodeSession({ run_id: run.id, workflow_id: 'w', node_id: 'n', session_id: 'node', profile: 'child' })
    expect(getWorkflowRun(run.id)?.user_id).toBe(42)
    expect(getWorkflowRunForSession('node', 'child')).toMatchObject({ id: run.id, profile: 'root', user_id: 42 })
    expect(getWorkflowRunForSession('node', 'wrong')).toBeNull()
    updateWorkflowRun(run.id, { status: 'completed' })
    expect(getWorkflowRun(run.id)?.user_id).toBe(42)
  })

  it('adds nullable ownership to existing runs without assigning them to another account', async () => {
    const { createWorkflowRun, getWorkflowRun } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const old = createWorkflowRun({ workflow_id: 'w' })
    state.db!.exec('ALTER TABLE workflow_runs DROP COLUMN user_id')
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    expect(getWorkflowRun(old.id)).toMatchObject({ id: old.id, workflow_id: 'w', user_id: null })
    expect(createWorkflowRun({ workflow_id: 'w', user_id: 2 }).user_id).toBe(2)
  })

  it('deletes workflow runs and their node session records', async () => {
    const { createWorkflow } = await import('../../packages/server/src/modules/studio/repositories/workflow-store')
    const {
      createWorkflowRun,
      createWorkflowRunNodeSession,
      deleteWorkflowRun,
      getWorkflowRun,
      listWorkflowRunNodeSessions,
      updateWorkflowRun,
    } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const workflow = createWorkflow({ name: 'Runs', profile: 'default' })
    const run = createWorkflowRun({ workflow_id: workflow.id, status: 'running' })
    createWorkflowRunNodeSession({
      run_id: run.id,
      workflow_id: workflow.id,
      node_id: 'node-1',
      session_id: 'session-1',
      status: 'completed',
    })
    updateWorkflowRun(run.id, { status: 'completed', finished_at: Date.now() })

    expect(listWorkflowRunNodeSessions(run.id)).toHaveLength(1)
    expect(deleteWorkflowRun(run.id)).toBe(true)

    expect(getWorkflowRun(run.id)).toBeNull()
    expect(listWorkflowRunNodeSessions(run.id)).toEqual([])
  })
})
