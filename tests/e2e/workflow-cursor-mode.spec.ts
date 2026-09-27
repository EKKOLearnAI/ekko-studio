import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

for (const target of [
  { label: 'Hermes', agent: 'hermes', mode: 'scoped' },
  { label: 'Ekko', agent: 'ekko-agent', mode: 'scoped' },
  { label: 'Codex', agent: 'codex', mode: 'global' },
]) {
  test(`workflow saves a valid ${target.label} mode after Codex global → Cursor`, async ({ page }) => {
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    const api = await mockHermesApi(page, {
      workflows: [{
        id: 'wf-cursor-mode', name: 'Cursor mode', profile: 'research', workspace: null,
        nodes: [{
          id: 'agent', type: 'agent', position: { x: 80, y: 80 },
          data: {
            title: 'Agent', agent: 'codex', agentMode: 'global',
            provider: 'test-provider', model: 'test-model', apiMode: 'chat_completions',
            input: 'Run', skills: [], images: [], approvalRequired: false,
          },
        }],
        edges: [], viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
      }],
      workflowRuns: [],
    })
    await page.route('**/api/agents/status', route => route.fulfill({ json: {
      revision: 1, updatedAt: new Date().toISOString(),
      agents: ['hermes', 'ekko-agent', 'codex', 'cursor'].map(id => ({
        id, installed: true, source: 'user-cli', path: `/test/${id}`, version: '1.0.0',
      })),
    } }))

    await page.goto('/#/hermes/workflow')
    const node = page.locator('.vue-flow__node[data-id="agent"]')
    await node.locator('.n-select').first().click()
    await page.getByText('Cursor', { exact: true }).last().click()
    await expect(node.locator('.n-select').first()).toContainText('Cursor')
    await expect.poll(() => api.requests.some(request => (
      request.pathname === '/api/hermes/skills' && new URLSearchParams(request.search).get('target') === 'cursor'
    ))).toBe(true)
    await node.locator('.n-select').first().click()
    await page.getByText(target.label, { exact: true }).last().click()
    await expect(node.locator('.n-select').first()).toContainText(target.label)
    if (target.mode === 'scoped') {
      await expect(node.locator('.model-trigger')).toContainText('test-model')
    }

    await page.locator('.header-actions').getByRole('button', { name: 'Save', exact: true }).click()
    const saves = () => api.requests.filter(request => (
      request.method === 'PATCH' && request.pathname === '/api/studio/workflows/wf-cursor-mode'
    ))
    await expect.poll(() => saves().length).toBe(1)
    const data = JSON.parse(saves()[0].postData || '{}').nodes[0].data
    expect(data).toMatchObject({
      agent: target.agent, agentMode: target.mode, provider: 'test-provider', model: 'test-model',
    })
    expect(data.priorAgentMode).toBeUndefined()
    expect(api.unexpectedRequests).toEqual([])
  })
}
