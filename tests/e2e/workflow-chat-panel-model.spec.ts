import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const cases = [
  { name: 'Ekko default effort', agent: 'ekko-agent', mode: 'scoped', model: 'ekko-runtime-model', effort: '', label: 'ekko-runtime-model' },
  { name: 'Hermes', agent: 'hermes', mode: 'scoped', model: 'hermes-runtime-model', effort: 'high', label: 'hermes-runtime-model' },
  { name: 'scoped Codex', agent: 'codex', mode: 'scoped', model: 'codex-scoped-runtime-model', effort: 'high', label: 'codex-scoped-runtime-model' },
  { name: 'global Codex', agent: 'codex', mode: 'global', model: 'codex-native-runtime-model', effort: 'high', label: 'codex-native-runtime-model' },
  { name: 'Cursor', agent: 'cursor', mode: 'global', model: 'cursor-native-high', effort: 'high', label: 'cursor-native-high' },
  { name: 'ZCode', agent: 'zcode', mode: 'global', model: 'glm-5-turbo', effort: 'enabled', label: 'glm-5-turbo' },
  { name: 'Agent default', agent: 'codex', mode: 'global', model: '', effort: 'high', label: 'Agent default model' },
  { name: 'global Codex on mobile', agent: 'codex', mode: 'global', model: 'codex-native-runtime-model', effort: 'high', label: 'codex-native-runtime-model', mobile: true },
] as const

for (const target of cases) {
  test(`workflow node chat panel displays ${target.name} session model`, async ({ page }) => {
    const mobile = 'mobile' in target && target.mobile
    await page.setViewportSize({ width: mobile ? 390 : 1600, height: 900 })
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    const node = { id: 'review', type: 'agent', position: { x: 80, y: 80 }, data: {
      title: 'Review', agent: target.agent, agentMode: target.mode, provider: target.mode === 'global' ? '' : 'test-provider',
      model: 'snapshot-model', reasoningEffort: 'low', input: 'Review', skills: [], images: [], approvalRequired: false,
    } }
    const sessionId = 'workflow-review-session'
    const session = {
      id: sessionId, title: 'Review session', profile: 'research', source: 'workflow', agent: target.agent, agent_mode: target.mode,
      provider: target.mode === 'global' ? 'global' : 'test-provider', model: target.model, reasoning_effort: target.effort,
      started_at: 1, ended_at: 2, message_count: 0, tool_call_count: 0, input_tokens: 0, output_tokens: 0,
      cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, billing_provider: null,
      estimated_cost_usd: 0, actual_cost_usd: null, cost_status: 'unavailable', messages: [],
    }
    const api = await mockHermesApi(page, {
      sessions: [session],
      workflows: [{ id: 'wf-chat-model', name: 'Node session model', profile: 'research', workspace: null,
        nodes: [{ ...node, data: { ...node.data, model: 'changed-editor-model' } }], edges: [],
        viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 2 }],
      workflowRuns: [{ id: 'run-chat-model', workflow_id: 'wf-chat-model', profile: 'research', workspace: null,
        start_node_ids: ['review'], status: 'completed', snapshot_nodes: [node], snapshot_edges: [], compiled_loops: [],
        started_at: 1, finished_at: 2, created_at: 1, error: null, edge_evaluations: [], loop_epochs: [],
        node_sessions: [{ id: 'execution', run_id: 'run-chat-model', workflow_id: 'wf-chat-model', node_id: 'review',
          execution_id: 'review', iteration_path: [], consumed_edge_evaluation_ids: [], session_id: sessionId,
          profile: 'research', agent: target.agent, agent_mode: target.mode, status: 'completed', sequence: 1,
          started_at: 1, finished_at: 2, created_at: 1, updated_at: 2, error: null }],
      }],
    })
    await page.route(url => url.pathname === `/api/studio/sessions/${sessionId}`, route => route.fulfill({ json: { session } }))
    await mockChatSocket(page)
    await page.addInitScript(id => {
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
        [id]: { session_id: id, messages: [], isWorking: false, messageLoadedCount: 0, messageTotal: 0 },
      }
    }, sessionId)
    if (mobile) {
      await page.goto('/#/hermes/workflow?workflowId=wf-chat-model&runId=run-chat-model&nodeId=review')
    } else {
      await page.goto('/#/hermes/workflow')
      await page.locator('.workflow-run-item').click()
      await page.locator('.vue-flow__node[data-id="review"]').click()
    }
    const panel = page.locator('.workflow-chat-panel-inner')
    const model = panel.locator('.input-model-button')
    await expect(model).toBeVisible()
    await expect(model.locator('.input-model-label')).toBeVisible()
    await expect(model).toHaveText(target.label)
    await expect(model).toHaveAttribute('aria-label', target.label)
    await expect(model).toBeDisabled()
    const effort = panel.locator('.reasoning-effort-button')
    await expect(effort).toContainText(target.effort === 'enabled' ? 'On' : target.effort ? 'High' : 'Default')
    await expect(effort).toBeDisabled()
    await effort.click({ force: true })
    await expect(page.locator('.reasoning-effort-slider-popover:visible')).toHaveCount(0)
    expect(api.requests.filter(request => request.pathname.endsWith('/reasoning-effort') && request.method !== 'GET')).toEqual([])
    await expect(model).not.toContainText('snapshot-model')
    await expect(model).not.toContainText('changed-editor-model')
    if (target.name === 'global Codex' || mobile) {
      await panel.screenshot({ path: `/tmp/workflow-chat-panel-model-${mobile ? 'mobile' : 'desktop'}.png`, animations: 'disabled' })
    }
    expect(api.unexpectedRequests).toEqual([])
  })
}
