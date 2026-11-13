import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

it('recovers persisted interrupted runs without rewriting completed evidence and permits a node rerun', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-workflow-restart-'))
  const script = `
    const assert = require('node:assert/strict');
    const base = process.cwd() + '/packages/server/src/modules/studio/';
    require(base + 'infrastructure/database/schemas').initAllHermesTables();
    assert.ok(require(base + 'infrastructure/database').getDb(), 'Use real SQLite');
    const store = require(base + 'repositories/workflow-run-store');
    const sessions = require(base + 'repositories/session-store');
    const { WorkflowManager } = require(base + 'services/workflow/manager');
    const manager = new WorkflowManager();
    const workflowId = 'restart-fixture';
    (async () => {
      if (process.env.RECOVERY_STAGE === 'seed') {
        const nodes = ['a', 'b'].map(id => ({ id, type: 'agent', data: { title: id, agent: 'ekko-agent', agentMode: 'scoped', input: 'Run ' + id } }));
        const edges = [{ id: 'a-b', source: 'a', target: 'b' }];
        manager.create({ id: workflowId, name: 'Restart fixture', workspace: process.env.HERMES_WEB_UI_HOME, nodes, edges });
        store.createWorkflowRun({ id: 'active', workflow_id: workflowId, status: 'running', snapshot_nodes: nodes, snapshot_edges: edges, start_node_ids: ['a'], started_at: 100 });
        for (const [node, status] of [['a', 'completed'], ['b', 'running']]) {
          sessions.createSession({ id: node, source: 'workflow', agent: 'ekko-agent', profile: 'default' });
          store.createWorkflowRunNodeSession({ id: node, run_id: 'active', workflow_id: workflowId, node_id: node, session_id: node, status, sequence: node === 'a' ? 0 : 2 });
        }
        sessions.addMessage({ session_id: 'a', role: 'assistant', content: 'Saved upstream output' });
        store.createWorkflowRunEdgeEvaluation({ id: 'saved-edge', run_id: 'active', workflow_id: workflowId, edge_id: 'a-b', source_node_id: 'a', target_node_id: 'b', source_outcome: 'success', status: 'taken', route: 'success', reason: null, sequence: 1, orchestration: { route: 'success' }, condition_evaluation: null });
        store.createWorkflowRunLoopEpoch({ id: 'saved-loop', run_id: 'active', workflow_id: workflowId, loop_id: 'loop', iteration: 0, iteration_path: [], status: 'completed', exit_reason: null, sequence: 3, started_at: 100, finished_at: 110 });
        store.createWorkflowRunNodeSession({ id: 'queued', run_id: 'active', workflow_id: workflowId, node_id: 'loop-node', session_id: 'b', status: 'queued', sequence: 4, iteration_path: [{ loopId: 'loop', iteration: 1 }] });
        store.createWorkflowRun({ id: 'queued-run', workflow_id: 'queued-workflow', status: 'queued' });
        store.createWorkflowRun({ id: 'finished', workflow_id: 'finished-workflow', status: 'completed' });
        console.log('Persisted active workflow before process exit');
        process.exit(23);
      }
      const completed = store.getWorkflowRunNodeSession('a');
      const edge = store.listWorkflowRunEdgeEvaluations('active');
      const loop = store.listWorkflowRunLoopEpochs('active');
      const finished = store.getWorkflowRun('finished');
      const aborted = [], executed = [];
      require(base + 'public/workflow-runtime').configureWorkflowRuntime({
        isRunCoordinatorAvailable: () => true,
        abortSession: async (id, reason) => { aborted.push({ id, reason }); },
        stopAgentRun() {}, deletePrimaryAgentSession: async () => false, getAvailableModelGroups: async () => [],
        runAndWait: async input => { executed.push(input); return { ok: true, output: 'Rerun output' }; },
      });
      assert.deepEqual(await manager.recoverActiveRuns(), { runs: 2, sessions: 1 });
      const recovered = store.getWorkflowRun('active');
      assert.equal(recovered.status, 'failed');
      assert.match(recovered.error, /server process exited or restarted/);
      assert.match(recovered.error, /rerun from a node/);
      assert.ok(recovered.finished_at);
      assert.equal(store.getWorkflowRun('queued-run').status, 'failed');
      assert.deepEqual(store.getWorkflowRun('finished'), finished);
      assert.deepEqual(store.getWorkflowRunNodeSession('a'), completed);
      for (const id of ['b', 'queued']) {
        assert.equal(store.getWorkflowRunNodeSession(id).status, 'failed');
        assert.equal(store.getWorkflowRunNodeSession(id).error, recovered.error);
      }
      assert.deepEqual(aborted, [{ id: 'b', reason: recovered.error }]);
      assert.deepEqual(store.listWorkflowRunEdgeEvaluations('active'), edge);
      const epochs = store.listWorkflowRunLoopEpochs('active');
      assert.deepEqual(epochs[0], loop[0]);
      assert.equal(epochs.length, 2);
      assert.equal(epochs[1].status, 'failed');
      assert.equal(epochs[1].iteration, 1);
      assert.deepEqual(await manager.recoverActiveRuns(), { runs: 0, sessions: 0 });
      assert.deepEqual(store.listWorkflowRunLoopEpochs('active'), epochs);
      const rerun = await manager.rerunFromNode(workflowId, 'active', 'b');
      assert.equal(rerun.run.status, 'completed', rerun.run.error);
      assert.equal(executed.length, 1);
      assert.equal(executed[0].workflow_node_id, 'b');
      assert.match(executed[0].input, /Saved upstream output/);
      assert.deepEqual(store.getWorkflowRunNodeSession('a'), completed);
      assert.deepEqual(store.listWorkflowRunEdgeEvaluations('active'), edge);
      console.log('Persisted restart recovery and node rerun verified');
    })().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
  `
  const run = (stage: string) => promisify(execFile)(process.execPath, ['-r', 'ts-node/register', '-e', script], {
    cwd: resolve('.'), timeout: 15_000,
    env: { ...process.env, RECOVERY_STAGE: stage, NODE_ENV: 'test', HERMES_WEB_UI_TEST_DB_DIR: join(directory, 'db'),
      HERMES_WEB_UI_HOME: join(directory, 'web'), HERMES_HOME: join(directory, 'hermes'),
      TS_NODE_PROJECT: 'packages/server/tsconfig.json', TS_NODE_FILES: 'true', TS_NODE_TRANSPILE_ONLY: 'true', TS_NODE_COMPILER_OPTIONS: '{"rootDir":"."}' },
  })
  try {
    await expect(run('seed')).rejects.toMatchObject({ code: 23, stdout: expect.stringContaining('Persisted active workflow') })
    const { stdout } = await run('recover')
    expect(stdout).toContain('Persisted restart recovery and node rerun verified')
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 35_000)
