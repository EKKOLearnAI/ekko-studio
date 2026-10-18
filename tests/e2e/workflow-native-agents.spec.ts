import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

for (const [agent, label] of [
  ['qwen', 'Qwen Code'], ['kimi', 'Kimi Code'], ['codebuddy', 'CodeBuddy'],
  ['qoder', 'Qoder'], ['copilot', 'GitHub Copilot'], ['zcode', 'ZCode'],
]) {
  test(`workflow restores and saves ${label} using its supported mode`, async ({ page }) => {
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    const api = await mockHermesApi(page, {
      workflows: [{
        id: 'wf-native', name: 'Native CLI', profile: 'research', workspace: null,
        nodes: [{ id: 'agent', type: 'agent', position: { x: 80, y: 80 }, data: {
          title: 'Agent', agent, agentMode: 'scoped', provider: 'test-provider', model: 'test-model',
          apiMode: 'chat_completions', input: 'Review', skills: [], images: [], approvalRequired: false,
        } }], edges: [], viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
      }], workflowRuns: [],
    })
    await page.route('**/api/agents/status', route => route.fulfill({ json: {
      revision: 1, updatedAt: new Date().toISOString(), agents: [{ id: agent, installed: true,
        source: 'user-cli', path: `/test/${agent}`, version: '1.0.0' }],
    } }))
    await page.goto('/#/hermes/workflow')
    const node = page.locator('.vue-flow__node[data-id="agent"]')
    await expect(node.locator('.n-select').first()).toContainText(label)
    await node.locator('.n-select').first().click()
    await expect(page.locator('.n-base-select-option__content:visible')).toHaveText([label])
    await page.locator('.n-base-select-option:visible').click()
    await expect(node.locator('.model-trigger')).toHaveCount(agent === 'qoder' ? 0 : 1)
    await page.locator('.header-actions').getByRole('button', { name: 'Save', exact: true }).click()
    const saves = () => api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/studio/workflows/wf-native')
    await expect.poll(() => saves().length).toBe(1)
    expect(JSON.parse(saves()[0].postData || '{}').nodes[0].data).toMatchObject({ agent, agentMode: agent === 'qoder' ? 'global' : 'scoped', ...(agent === 'qoder' ? {} : { provider: 'test-provider', model: 'test-model' }) })
    expect(api.unexpectedRequests).toEqual([])
  })
}
