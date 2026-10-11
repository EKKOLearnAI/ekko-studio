import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

for (const target of [
  { agent: 'codex', label: 'Codex', model: 'native-review', family: 'Native Review', effort: 'high', effortLabel: 'High', choices: ['low', 'high'] },
  { agent: 'cursor', label: 'Cursor', model: 'native-review-high', family: 'Native Review', effort: 'high', effortLabel: 'High', choices: ['low', 'high'], variants: true },
  { agent: 'antigravity', label: 'Antigravity', model: 'native-review-high', family: 'Native Review', effort: 'high', effortLabel: 'High', choices: ['low', 'high'], variants: true },
  { agent: 'zcode', label: 'ZCode', model: 'glm-5-turbo', family: 'GLM-5-Turbo', effort: 'enabled', effortLabel: 'On', choices: ['disabled', 'enabled'] },
]) {
  test(`workflow saves and restores ${target.label} global native model and effort`, async ({ page }) => {
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    const workflow = {
      id: 'wf-global-native', name: 'Global native model', profile: 'research', workspace: null,
      nodes: [{ id: 'agent', type: 'agent', position: { x: 80, y: 80 }, data: {
        title: 'Agent', agent: target.agent, agentMode: 'scoped', provider: 'test-provider', model: 'test-model',
        apiMode: 'chat_completions', reasoningEffort: 'high', input: 'Review', skills: [], images: [], approvalRequired: false,
      } }], edges: [], viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
    }
    const api = await mockHermesApi(page, { workflows: [workflow], workflowRuns: [] })
    await page.route('**/api/agents/status', route => route.fulfill({ json: {
      revision: 1, updatedAt: new Date().toISOString(), agents: [{ id: target.agent, installed: true,
        source: 'user-cli', path: `/test/${target.agent}`, version: '1.0.0' }],
    } }))
    await page.route('**/api/coding-agents/models?*', route => route.fulfill({ json: { agents: [{
      agentId: target.agent, name: target.label, status: 'ready', source: 'cli', scope: 'available',
      models: target.variants ? target.choices.map(effort => ({
        id: `native-review-${effort}`, name: `Native Review (${effort})`, modelFamily: 'native-review',
        modelFamilyName: target.family, reasoningEffort: effort, reasoningEfforts: target.choices,
      })) : [{ id: target.model, name: target.family, reasoningEfforts: target.choices }],
    }] } }))
    await page.goto('/#/hermes/workflow')
    const node = page.locator('.vue-flow__node[data-id="agent"]')
    const mode = node.locator('.n-select').nth(1)
    if (target.agent !== 'cursor') {
      await expect(mode).toContainText('Model')
      await mode.click()
      await page.getByText('Global', { exact: true }).last().click()
    }
    await node.locator('.native-model-trigger').click()
    const menu = page.locator('.model-cascader:visible')
    await expect(menu.getByRole('menuitemradio', { name: target.family, exact: true })).toHaveCount(1)
    await menu.getByRole('menuitemradio', { name: target.family, exact: true }).click()
    const effortField = node.locator('.node-field-row').filter({ has: page.locator('.native-reasoning-effort') })
    await expect(effortField.locator('.node-field-label-row')).toHaveText('Reasoning effort')
    await expect(effortField.locator('.native-model-trigger')).toHaveCount(0)
    await effortField.locator('.native-reasoning-effort').click()
    await page.getByText(target.effortLabel, { exact: true }).last().click()
    if (target.agent !== 'cursor') {
      await mode.click()
      await page.getByText('Model', { exact: true }).last().click()
      await expect(node.locator('.model-trigger')).toContainText('test-model')
      await mode.click()
      await page.getByText('Global', { exact: true }).last().click()
      await expect(node.locator('.native-model-trigger')).toHaveText(target.family)
      await expect(node.locator('.native-reasoning-effort')).toContainText(target.effortLabel)
    }
    await page.locator('.header-actions').getByRole('button', { name: 'Save', exact: true }).click()
    const saves = () => api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/studio/workflows/wf-global-native')
    await expect.poll(() => saves().length).toBe(1)
    const saved = JSON.parse(saves()[0].postData || '{}')
    expect(saved.nodes[0].data).toMatchObject({ agent: target.agent, agentMode: 'global', provider: '', model: target.model, reasoningEffort: target.effort })
    Object.assign(workflow, saved)
    await page.reload()
    await expect(node.locator('.native-model-trigger')).toHaveText(target.family)
    await expect(node.locator('.native-reasoning-effort')).toContainText(target.effortLabel)
    // Starting a workflow refreshes installed Agents, which also normalizes node
    // targets. Native selections must survive that refresh and the final save.
    await page.getByRole('button', { name: 'Start Execution', exact: true }).click()
    await page.getByTestId('workflow-run-budget-modal').getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect.poll(() => api.requests.some(request => request.method === 'POST' && request.pathname === '/api/studio/workflows/wf-global-native/run')).toBe(true)
    expect(JSON.parse(saves().at(-1)?.postData || '{}').nodes[0].data).toMatchObject({
      agentMode: 'global', provider: '', model: target.model, reasoningEffort: target.effort,
    })
    expect(api.unexpectedRequests).toEqual([])
  })
}
