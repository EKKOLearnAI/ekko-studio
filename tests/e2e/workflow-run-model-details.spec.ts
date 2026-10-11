import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`workflow run details show frozen models and efforts on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    const configurations = [
      { id: 'hermes', title: 'Historical Hermes', agent: 'hermes', agentMode: 'scoped', provider: 'old-provider', model: 'old-hermes-model', reasoningEffort: 'high' },
      { id: 'scoped', title: 'Scoped Codex', agent: 'codex', agentMode: 'scoped', provider: 'old-provider', model: 'old-scoped-model', reasoningEffort: 'xhigh' },
      { id: 'global', title: 'Global Codex', agent: 'codex', agentMode: 'global', provider: '', model: 'old-native-model', reasoningEffort: 'ultra' },
      { id: 'cursor', title: 'Cursor variant', agent: 'cursor', agentMode: 'global', provider: '', model: 'old-native-family-with-a-very-long-model-id-high', reasoningEffort: 'high' },
      { id: 'zcode', title: 'ZCode thinking', agent: 'zcode', agentMode: 'global', provider: '', model: 'glm-5-turbo', reasoningEffort: 'enabled' },
      { id: 'default', title: 'Agent defaults', agent: 'codex', agentMode: 'global', provider: '', model: '', reasoningEffort: 'default' },
      { id: 'legacy', title: 'Legacy run', agent: 'codex', agentMode: 'global' },
    ]
    const snapshotNodes = configurations.map((data, index) => ({
      id: data.id, type: 'agent', position: { x: index * 420, y: 80 },
      data: { ...data, input: 'Review', skills: [], images: [], approvalRequired: false },
    }))
    const api = await mockHermesApi(page, {
      workflows: [{ id: 'wf-model-history', name: 'Model history', profile: 'research', workspace: null,
        nodes: snapshotNodes.map(node => ({ ...node, data: { ...node.data, title: 'Changed title', model: 'changed-model', reasoningEffort: 'low' } })),
        edges: [], viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 2 }],
      workflowRuns: [{ id: 'run-model-history', workflow_id: 'wf-model-history', profile: 'research', workspace: null,
        status: 'completed', start_node_ids: [], snapshot_nodes: snapshotNodes, snapshot_edges: [], compiled_loops: [],
        node_sessions: [], edge_evaluations: [], loop_epochs: [], started_at: 1000, finished_at: 2000, created_at: 1, error: null }],
    })
    await page.goto('/#/hermes/workflow')
    await page.locator('.workflow-run-item').click()
    await page.getByTestId('workflow-run-evidence-details-trigger').click()
    const details = page.getByTestId('workflow-run-evidence-details-modal')
    await expect(details).toBeVisible()
    const models = details.getByTestId('workflow-run-model-details')
    await expect(models).toContainText('Node model configuration')
    await expect(models.locator('article')).toHaveCount(configurations.length)
    for (const [id, model, effort] of [
      ['hermes', 'old-hermes-model', 'High'],
      ['scoped', 'old-scoped-model', 'Extra high'],
      ['global', 'old-native-model', 'Ultra'],
      ['cursor', 'old-native-family-with-a-very-long-model-id-high', 'High'],
      ['zcode', 'glm-5-turbo', 'On'],
      ['default', 'Agent default model', 'Default'],
      ['legacy', 'Not recorded', 'Not recorded'],
    ]) {
      const node = models.locator(`article[data-node-id="${id}"]`)
      await expect(node.getByTestId('workflow-run-node-model')).toHaveText(model!)
      await expect(node.getByTestId('workflow-run-node-effort')).toHaveText(effort!)
    }
    await expect(models.locator('[data-node-id="scoped"]')).toContainText('old-provider')
    await expect(models.locator('[data-node-id="global"]')).toContainText('Global')
    await expect(models).not.toContainText('changed-model')
    await expect(models).not.toContainText('Changed title')
    await expect(models.locator('input, button, .n-select')).toHaveCount(0)
    expect(await details.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/workflow-run-model-details-${viewport.name}.png`, animations: 'disabled' })
    expect(api.unexpectedRequests).toEqual([])
  })
}
