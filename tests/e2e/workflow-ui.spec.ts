import { readFile } from 'fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY, TEST_MODEL_GROUP } from './fixtures'

async function selectWorkflowScheduleFrequency(page: Page, modal: Locator, frequency: string) {
  await modal.getByTestId('workflow-schedule-frequency').click()
  await page.getByText(frequency, { exact: true }).last().click()
}

async function selectWorkflowScheduleField(page: Page, modal: Locator, testId: string, value: string) {
  await modal.getByTestId(testId).click()
  await page.getByText(value, { exact: true }).last().click()
}

test('workflow Run sends the selected total time budget', async ({ page }) => {
  const renderErrors: string[] = []
  page.on('console', message => { if (message.type() === 'error' && message.text().includes('uncaught Vue error')) renderErrors.push(message.text()) })
  page.on('pageerror', error => renderErrors.push(error.message))
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, {
    workflows: [{
      id: 'wf-budget', name: 'Budget workflow', profile: 'research', workspace: null,
      nodes: [{
        id: 'agent', type: 'agent', position: { x: 80, y: 80 },
        data: {
          title: 'Agent', agent: 'hermes', input: 'Run', skills: [], images: [], approvalRequired: false,
        },
      }],
      edges: [], viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
    }],
    workflowRuns: [],
  })

  await page.goto('/#/hermes/workflow')
  await page.getByRole('button', { name: 'Start Execution' }).click()
  const modal = page.getByTestId('workflow-run-budget-modal')
  await expect(modal).toBeVisible()
  await expect(modal).toContainText('Choose Run time budget')

  await modal.locator('.n-select').click()
  await page.getByText('Custom', { exact: true }).last().click()
  await modal.locator('.n-input-number input').fill('12.5')
  await modal.getByRole('button', { name: 'Confirm' }).click()

  await expect.poll(() => api.requests.filter(request => (
    request.method === 'POST' && request.pathname === '/api/studio/workflows/wf-budget/run'
  )).length).toBe(1)
  const runRequest = api.requests.find(request => (
    request.method === 'POST' && request.pathname === '/api/studio/workflows/wf-budget/run'
  ))!
  expect(JSON.parse(runRequest.postData || '{}')).toEqual({ timeout_ms: 750_000 })
  await expect(modal).toBeHidden()
  expect(renderErrors).toEqual([])
  expect(api.unexpectedRequests).toEqual([])
})

for (const agent of ['Codex', 'DeepSeek Harness']) test(`workflow ${agent} nodes hide auth providers and reset auth selections`, async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const authGroup = {
    provider: 'openai-codex',
    label: 'OpenAI Codex Subscription',
    base_url: '',
    models: ['gpt-5-codex'],
    available_models: ['gpt-5-codex'],
    api_key: '',
    api_mode: 'codex_app_server',
    builtin: true,
  }
  const api = await mockHermesApi(page, {
    modelGroups: [authGroup, TEST_MODEL_GROUP],
    workflows: [{
      id: 'wf-auth-provider', name: 'Provider policy', profile: 'research', workspace: null,
      nodes: [{
        id: 'agent', type: 'agent', position: { x: 80, y: 80 },
        data: {
          title: 'Agent', agent: 'hermes', provider: 'openai-codex', model: 'gpt-5-codex',
          apiMode: 'codex_responses', input: 'Run', skills: [], images: [], approvalRequired: false,
        },
      }],
      edges: [], viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
    }],
    workflowRuns: [],
  })

  await page.goto('/#/hermes/workflow')
  const node = page.locator('.vue-flow__node')
  await expect(node.locator('.model-trigger')).toContainText('gpt-5-codex')

  await node.locator('.n-select').first().click()
  await page.getByText(agent, { exact: true }).last().click()
  await expect(node.locator('.model-trigger')).toContainText('test-model')

  await node.locator('.model-trigger').click()
  const modelDialog = page.getByRole('dialog')
  await expect(modelDialog.getByText('Test Provider', { exact: true })).toBeVisible()
  await expect(modelDialog.getByText('OpenAI Codex Subscription', { exact: true })).toHaveCount(0)
  if (agent === 'DeepSeek Harness') {
    await page.keyboard.press('Escape')
    const preset = node.getByTestId('dsh-session-preset')
    await expect(preset).toContainText('Standard mode (Default)')
    await preset.locator('.n-base-selection').click()
    await page.getByText('Minimal mode', { exact: true }).last().click()
    await page.locator('.header-actions').getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/studio/workflows/wf-auth-provider').length).toBeGreaterThan(0)
    const saved = api.requests.findLast(request => request.method === 'PATCH' && request.pathname === '/api/studio/workflows/wf-auth-provider')!
    expect(JSON.parse(saved.postData || '{}').nodes[0].data).toMatchObject({ agent: 'dsh', agentPreset: 'minimal', provider: 'test-provider', model: 'test-model' })
  }
  if (agent === 'DeepSeek Harness') {
    const saved = api.requests.findLast(request => request.method === 'PATCH' && request.pathname === '/api/studio/workflows/wf-auth-provider')!
    const workflow = { id: 'wf-auth-provider', name: 'Provider policy', profile: 'research', created_at: 1, updated_at: 2, ...JSON.parse(saved.postData || '{}') }
    await page.route('**/api/studio/workflows', route => route.fulfill({ json: { workflows: [workflow] } }))
    await page.reload()
    await expect(page.getByTestId('dsh-session-preset')).toContainText('Minimal mode')
    await page.screenshot({ path: '/tmp/dsh-workflow-mode.png', animations: 'disabled' })
  }
  expect(api.unexpectedRequests).toEqual([])
})

test('workflow canvas exposes orchestration editing and portability controls', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const nodes = [
    { id: 'a', type: 'agent', position: { x: 0, y: 80 }, data: { title: 'Agent A', agent: 'hermes', input: 'Run Agent A', skills: [], images: [], approvalRequired: false } },
    { id: 'b', type: 'agent', position: { x: 420, y: 80 }, data: { title: 'Agent B', agent: 'hermes', input: 'Run Agent B', skills: [], images: [], approvalRequired: false } },
  ]
  const edges = [{ id: 'a-b', source: 'a', target: 'b', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep' }]
  const legacySnapshotNodes = nodes.map(({ position: _position, ...node }) => node)
  const api = await mockHermesApi(page, { workflows: [{
    id: 'wf-1', name: 'Loop workflow', profile: 'research', workspace: null,
    nodes, edges, viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
  }], workflowImportDocument: { name: 'Imported flow', nodes: [{ id: 'imported', type: 'agent', position: { x: 0, y: 0 }, data: { title: 'Imported', agent: 'hermes' } }], edges: [], viewport: null }, workflowRuns: [{
    id: 'run-1', workflow_id: 'wf-1', profile: 'research', workspace: null, start_node_ids: [], status: 'completed',
    snapshot_nodes: legacySnapshotNodes, snapshot_edges: edges, compiled_loops: [], requested_timeout_ms: 3_600_000, deadline_at: 3_601_000, started_at: 1_000, finished_at: 3_520_000, created_at: 1, error: null,
    node_sessions: Array.from({ length: 18 }, (_, index) => ({
      id: `node-${index + 1}`, run_id: 'run-1', workflow_id: 'wf-1', node_id: index % 2 === 0 ? 'a' : 'b', execution_id: `rerun:2:node:${index + 1}`,
      iteration_path: [{ executionScope: 'rerun:2', loopId: 'loop:a', iteration: index + 1 }], consumed_edge_evaluation_ids: [`edge-${index + 1}`],
      session_id: `session-${index + 1}`, profile: 'research', agent: 'hermes', agent_mode: '', status: 'completed', sequence: 40 + index,
      remaining_timeout_ms_at_start: 3_500_000 - (index * 180_000), started_at: 1_100 + index, finished_at: 1_150 + index, created_at: 1, updated_at: 2, error: null,
    })),
    edge_evaluations: [
      ...Array.from({ length: 18 }, (_, index) => ({ id: `edge-${index + 1}`, run_id: 'run-1', workflow_id: 'wf-1', edge_id: 'a-b', source_node_id: 'a', source_execution_id: `rerun:2:a:${index + 1}`, iteration_path: [{ executionScope: 'rerun:2', loopId: 'loop:a', iteration: index + 1 }], target_node_id: 'b', source_outcome: 'success', status: 'taken', route: 'success', reason: null, sequence: 4 + index, orchestration: { route: 'success' }, condition_evaluation: null, evaluated_at: 1_050 + index })),
      { id: 'delivery-candidate', run_id: 'run-1', workflow_id: 'wf-1', edge_id: 'b-a-candidate', source_node_id: 'b', source_execution_id: 'rerun:2:b:18', iteration_path: [{ executionScope: 'rerun:2', loopId: 'loop:a', iteration: 18 }], target_node_id: 'a', source_outcome: 'success', status: 'taken', route: 'success', reason: null, sequence: 22, orchestration: { route: 'success' }, condition_evaluation: null, evaluated_at: 1_080 },
    ],
    loop_epochs: [{ id: 'loop-1', run_id: 'run-1', workflow_id: 'wf-1', loop_id: 'loop:a', iteration: 18, iteration_path: [{ executionScope: 'rerun:2', loopId: 'loop:a', iteration: 18 }], status: 'completed', exit_reason: 'feedback_not_taken', sequence: 30, started_at: 1_090, finished_at: 1_095 }],
  }] })
  await page.goto('/#/hermes/workflow')
  await expect(page.locator('.header-workflow-title')).toHaveText('Loop workflow')
  const firstNode = page.locator('.vue-flow__node[data-id="a"]')
  await expect(firstNode).toHaveAttribute('style', /translate\(0px,\s*80px\)/)
  await expect(firstNode).toHaveCSS('width', '300px')
  await expect(firstNode).toHaveCSS('height', '550px')
  const importButton = page.getByRole('button', { name: 'Import Workflow' })
  await expect(importButton).toBeVisible()
  await expect(importButton).toHaveText('')
  await expect(importButton.locator('svg')).toBeVisible()
  await expect(importButton.locator('svg path').nth(0)).toHaveAttribute('d', 'M12 16V5')
  await expect(importButton.locator('svg path').nth(1)).toHaveAttribute('d', 'm8 9 4-4 4 4')
  const exportButton = page.getByRole('button', { name: 'Export Workflow' })
  await expect(exportButton).toBeVisible()
  await expect(exportButton).toHaveText('')
  await expect(exportButton.locator('svg')).toBeVisible()
  await expect(exportButton.locator('svg path').nth(0)).toHaveAttribute('d', 'M12 3v11')
  await expect(exportButton.locator('svg path').nth(1)).toHaveAttribute('d', 'm8 10 4 4 4-4')
  const toolbarLabels = await page.locator('.header-actions button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))
  expect(toolbarLabels.indexOf('Import Workflow')).toBeLessThan(toolbarLabels.indexOf('Export Workflow'))
  const downloadPromise = page.waitForEvent('download')
  await exportButton.click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('Loop-workflow.workflow.json')
  const downloadPath = await download.path()
  expect(downloadPath).toBeTruthy()
  const exported = JSON.parse(await readFile(downloadPath!, 'utf8'))
  expect(exported).toMatchObject({ format: 'hermes-studio.workflow', version: 1, definition: { name: 'Loop workflow' } })
  expect(JSON.stringify(exported)).not.toMatch(/workspace|session_id|run_id|token|api[_-]?key/i)
  const chooser = page.waitForEvent('filechooser')
  await importButton.click()
  const fileChooser = await chooser
  await fileChooser.setFiles({ name: 'import.workflow.json', mimeType: 'application/json', buffer: Buffer.from('{}') })
  await expect(page.getByTestId('workflow-import-summary')).toHaveText('Imported flow · 1 nodes · 0 links')
  expect(api.requests.filter(request => request.pathname === '/api/studio/workflows/import/confirm')).toHaveLength(0)
  await page.getByTestId('workflow-import-confirm').click()
  await expect(page.locator('.header-workflow-title')).toHaveText('Imported flow')
  expect(api.requests.filter(request => request.pathname === '/api/studio/workflows/import/confirm')).toHaveLength(1)
  const cancelChooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import Workflow' }).click()
  const cancelChooser = await cancelChooserPromise
  await cancelChooser.setFiles({ name: 'cancel.workflow.json', mimeType: 'application/json', buffer: Buffer.from('{}') })
  await expect(page.getByTestId('workflow-import-summary')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('workflow-import-summary')).toHaveCount(0)
  expect(api.requests.filter(request => request.pathname === '/api/studio/workflows/import/cancel')).toHaveLength(1)
  expect(api.requests.filter(request => request.pathname === '/api/studio/workflows/import/confirm')).toHaveLength(1)
  await page.locator('.workflow-list-item').filter({ hasText: 'Loop workflow' }).click()
  await expect(page.locator('.header-workflow-title')).toHaveText('Loop workflow')
  const runItem = page.locator('.workflow-run-item')
  await runItem.click()
  await expect(firstNode).toHaveAttribute('style', /translate\(0px,\s*80px\)/)
  await expect(firstNode).toHaveCSS('width', '300px')
  await expect(firstNode).toHaveCSS('height', '550px')
  const evidence = page.getByLabel('Workflow execution details')
  const tabs = evidence.getByTestId('workflow-evidence-tabs')
  await expect(tabs.getByRole('tab', { name: 'Executed 18' })).toBeVisible()
  await expect(tabs.getByRole('tab', { name: 'Other judgments 1' })).toBeVisible()
  await expect(tabs.getByRole('tab', { name: 'Loop events 1' })).toBeVisible()
  await expect(evidence.getByTestId('workflow-actual-path-compact')).toContainText('Agent A → Agent B')
  await expect(evidence.getByTestId('workflow-actual-path-compact')).not.toContainText('Agent B → Agent A')
  await expect(evidence.getByTestId('workflow-run-budget-compact')).toContainText('Budget 1h · elapsed 58m 39s · remaining 1m 21s')
  await expect(evidence.getByText('remaining at node start')).toHaveCount(0)
  const evidenceList = evidence.locator('.workflow-evidence-list')
  await expect(evidenceList).toHaveCSS('overflow-y', 'visible')
  await expect(evidenceList.locator('.workflow-evidence-row')).toHaveCount(18)
  const runsPanel = page.locator('.workflow-runs-panel')
  const pages = page.getByTestId('workflow-runs-pages')
  const historyPage = page.getByTestId('workflow-runs-history-page')
  const detailsPage = page.getByTestId('workflow-run-details-page')
  await expect(runsPanel).toHaveCSS('width', '280px')
  const panelClientWidth = await runsPanel.evaluate(element => element.clientWidth)
  expect(await historyPage.evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(panelClientWidth, 3)
  expect(await detailsPage.evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(panelClientWidth, 3)
  await expect(runItem).toHaveAttribute('aria-current', 'true')
  const detailsScroller = detailsPage.locator('.workflow-runs-page-scroll')
  await detailsScroller.evaluate(element => { element.scrollTop = 240 })
  await pages.dispatchEvent('pointerdown', { pointerId: 41, isPrimary: true, button: 0, clientX: 220, clientY: 200 })
  await pages.dispatchEvent('pointerup', { pointerId: 41, isPrimary: true, button: 0, clientX: 280, clientY: 202 })
  await expect(historyPage).toHaveAttribute('aria-hidden', 'false')
  const panelBox = await runsPanel.boundingBox()
  expect(panelBox).not.toBeNull()
  await expect.poll(async () => historyPage.evaluate((element, left) => Math.abs(element.getBoundingClientRect().left - left) <= 1.5, panelBox!.x)).toBe(true)
  const historyTitleBox = await historyPage.locator('.workflow-runs-title').boundingBox()
  expect(historyTitleBox).not.toBeNull()
  const swipeStartX = historyTitleBox!.x + 8
  const swipeStartY = historyTitleBox!.y + (historyTitleBox!.height / 2)
  await page.mouse.move(swipeStartX, swipeStartY)
  await page.mouse.down()
  await page.mouse.move(swipeStartX - 90, swipeStartY + 2)
  await page.mouse.up()
  await expect(detailsPage).toHaveAttribute('aria-hidden', 'false')
  expect(await detailsScroller.evaluate(element => element.scrollTop)).toBe(240)
  await tabs.getByRole('tab', { name: 'Other judgments 1' }).click()
  const candidateRow = evidence.locator('.workflow-evidence-row').filter({ hasText: 'Agent B → Agent A' })
  await expect(candidateRow).toContainText('Evaluated, not executed')
  await expect(candidateRow).toContainText('evaluated as a candidate')
  await candidateRow.getByRole('button', { name: /Connection judgment/ }).click()
  const candidateDetail = page.getByTestId('workflow-evidence-detail-modal')
  await expect(candidateDetail).toContainText('evaluated as a candidate')
  await expect(candidateDetail.getByText('This connection was not used', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(candidateDetail).toBeHidden()
  await tabs.getByRole('tab', { name: 'Loop events 1' }).click()
  await expect(evidence.getByText('Loop pass 19', { exact: true })).toBeVisible()
  await page.getByTestId('workflow-run-evidence-details-trigger').click()
  const runDetails = page.getByTestId('workflow-run-evidence-details-modal')
  await expect(runDetails).toBeVisible()
  await pages.dispatchEvent('pointerdown', { pointerId: 43, isPrimary: true, button: 0, clientX: 180, clientY: 200 })
  await pages.dispatchEvent('pointerup', { pointerId: 43, isPrimary: true, button: 0, clientX: 250, clientY: 202 })
  await expect(detailsPage).toHaveAttribute('aria-hidden', 'false')
  await expect(runDetails.getByText('Actual path steps', { exact: true })).toBeVisible()
  await expect(runDetails.getByText('Time budget details', { exact: true })).toBeVisible()
  await expect(runDetails.getByText('remaining at node start')).toHaveCount(18)
  await page.keyboard.press('Escape')
  await expect(runDetails).toBeHidden()
  await tabs.getByRole('tab', { name: 'Executed 18' }).click()
  await evidence.locator('.workflow-evidence-row').first().getByRole('button', { name: /Connection judgment/ }).click()
  const evidenceDetailModal = page.getByTestId('workflow-evidence-detail-modal')
  await expect(evidenceDetailModal).toBeVisible()
  await expect(evidenceDetailModal.getByText('Agent A → Agent B', { exact: true })).toBeVisible()
  await expect(evidenceDetailModal.getByText('a-b', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(evidenceDetailModal).toBeHidden()
  await page.getByTestId('workflow-run-back').click()
  await expect(runItem).toHaveClass(/active/)
  await expect(page.getByTestId('workflow-run-details-page')).toHaveAttribute('aria-hidden', 'true')
  await expect(page.getByLabel('Workflow execution details')).toBeHidden()
  await page.getByRole('button', { name: 'Hide run records' }).click()
  await expect(page.getByLabel('Workflow execution details')).toHaveCount(0)
  await expect(page.locator('.workflow-run-snapshot-indicator')).toHaveCount(0)
  await expect(firstNode.locator('input').first()).toBeEnabled()
  const joinHelpIcons = page.getByTestId('workflow-node-join-help')
  const joinHelp = page.getByText('All incoming routes must be taken; if one does not match, this node is skipped. Example: wait for both parallel checks.', { exact: true })
  await expect(joinHelpIcons).toHaveCount(2)
  await expect(joinHelp).toHaveCount(0)
  await joinHelpIcons.first().hover()
  await expect(joinHelp).toBeVisible()
  const edge = page.locator('.vue-flow__edge[data-id="a-b"]')
  const edgeLabel = page.locator('[data-testid="workflow-edge-condition-label"][data-edge-id="a-b"]')
  await expect(edgeLabel).toHaveText('Source returned normally')
  await edge.click({ force: true })
  await expect(edge).toHaveClass(/workflow-edge--preview/)
  await expect(edge).toHaveClass(/animated/)
  await expect(page.getByText('Edit connection', { exact: true })).toHaveCount(0)
  await edge.dblclick({ force: true })
  const edgeDialog = page.locator('.workflow-edge-editor-form').first()
  await expect(page.getByText('Edit connection', { exact: true })).toBeVisible()
  const connectionSummary = edgeDialog.getByTestId('workflow-edge-connection-summary')
  await expect(connectionSummary).toContainText('Agent A')
  await expect(connectionSummary).toContainText('Agent B')
  const ruleSteps = edgeDialog.getByTestId('workflow-edge-rule-steps')
  await expect(ruleSteps).toHaveCount(0)
  await expect(edgeDialog.getByTestId('workflow-edge-continue-when-label')).toHaveText('Required source result')
  await expect(edgeDialog.getByTestId('workflow-edge-optional-check-label')).toHaveText('Which reply data should be checked?')
  const routeHelp = page.getByText('First match the source result. success: source succeeded; failure: source failed; always: either result. A condition, when present, must also match.', { exact: true })
  const routeExample = page.getByText('Example: use success for the normal path, failure for error handling, and always for cleanup.', { exact: true })
  await expect(routeHelp).toHaveCount(0)
  await expect(routeExample).toHaveCount(0)
  await page.getByTestId('workflow-edge-route-help').hover()
  await expect(routeHelp).toBeVisible()
  await expect(routeExample).toBeVisible()
  await edgeDialog.locator('.n-select').first().click()
  for (const route of ['Source returned normally', 'Source execution failed', 'Either result']) {
    await expect(page.getByText(route, { exact: true }).last()).toBeVisible()
  }
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('workflow-edge-condition-path-preset')).toBeVisible()
  await expect(page.getByTestId('workflow-edge-condition-operator')).toHaveCount(0)
  await page.getByTestId('workflow-edge-condition-path-preset').click()
  await expect(page.getByText('Do not inspect the reply', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Entire successful reply text (output, recommended)', { exact: true }).last()).toBeVisible()
  const structuredOutputOption = page.getByText('One JSON field value (outputJson.*)', { exact: true }).last()
  await expect(structuredOutputOption).toBeVisible()
  await expect(page.getByText('Failure error text (error)', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Advanced data path', { exact: true }).last()).toBeVisible()
  await structuredOutputOption.click()
  await expect(edgeDialog.getByTestId('workflow-edge-compare-using-label')).toHaveText('Compare using')
  await expect(edgeDialog.getByTestId('workflow-edge-expected-type-label')).toHaveText('Interpret expected value as')
  await expect(edgeDialog.getByTestId('workflow-edge-expected-value-label')).toHaveText('Expected field value')
  const structuredOutputPath = edgeDialog.getByTestId('workflow-edge-condition-path').locator('input')
  await expect(structuredOutputPath).toHaveValue('outputJson')
  await structuredOutputPath.fill('outputJson.route_token')
  await edgeDialog.getByTestId('workflow-edge-condition-value').locator('input').fill('HSR_RELEASED_OK')
  const structuredOutputHelp = page.getByText('Parses a complete JSON reply or exactly one fenced json block. Missing, malformed, or multiple JSON blocks leave outputJson unavailable, so the condition does not match.', { exact: true })
  await expect(structuredOutputHelp).toHaveCount(0)
  await page.getByTestId('workflow-edge-condition-path-help').hover()
  await expect(structuredOutputHelp).toBeVisible()
  await edgeDialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(edgeLabel).toContainText('route_token')
  await expect(edgeLabel).toContainText('Equals')
  await expect(edgeLabel).toContainText('HSR_RELEASED_OK')
  const workflowPatchCount = api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/studio/workflows/wf-1').length
  await page.locator('.header-actions').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/studio/workflows/wf-1').length).toBe(workflowPatchCount + 1)
  const workflowPatchRequest = api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/studio/workflows/wf-1').at(-1)!
  const workflowPatch = JSON.parse(workflowPatchRequest.postData || '{}')
  expect(workflowPatch.edges[0].data.orchestration.condition).toEqual({
    path: 'outputJson.route_token', operator: 'equals', value: 'HSR_RELEASED_OK',
  })
  expect(workflowPatch.edges[0]).not.toHaveProperty('label')
  expect(workflowPatch.edges[0]).not.toHaveProperty('labelStyle')
  expect(workflowPatch.edges[0]).not.toHaveProperty('labelBgStyle')
  for (const key of ['Enter', 'Space']) {
    await edgeLabel.focus()
    await expect(edgeLabel).toBeFocused()
    await page.keyboard.press(key)
    await expect(edgeDialog).toBeVisible()
    await expect(edgeDialog.getByTestId('workflow-edge-condition-path').locator('input')).toHaveValue('outputJson.route_token')
    await page.keyboard.press('Escape')
    await expect(edgeDialog).toBeHidden()
  }
  await edgeLabel.dblclick()
  await expect(edgeDialog.getByTestId('workflow-edge-condition-path').locator('input')).toHaveValue('outputJson.route_token')
  const conditionSemantics = edgeDialog.getByTestId('workflow-edge-condition-semantics')
  const conditionSemanticsText = conditionSemantics.locator('p')
  const operatorLabels = [
    'Equals', 'Does not equal', 'Contains', 'Does not contain', 'Exists', 'Does not exist',
    'Greater than', 'Greater than or equal', 'Less than', 'Less than or equal', 'Is in list', 'Is not in list',
  ]
  let currentOperatorIndex = 0
  const chooseOperator = async (label: string) => {
    const index = operatorLabels.indexOf(label)
    expect(index).toBeGreaterThanOrEqual(0)
    const select = edgeDialog.getByTestId('workflow-edge-condition-operator').locator('.n-base-selection')
    await select.click()
    const key = index >= currentOperatorIndex ? 'ArrowDown' : 'ArrowUp'
    for (let step = 0; step < Math.abs(index - currentOperatorIndex); step += 1) await page.keyboard.press(key)
    await page.keyboard.press('Enter')
    currentOperatorIndex = index
    await expect(edgeDialog.getByTestId('workflow-edge-condition-operator')).toContainText(label)
    await expect(page.locator('.n-base-select-menu:visible')).toHaveCount(0)
  }
  await expect(conditionSemanticsText).toHaveText('Reads the value at outputJson.route_token. Matches only when that field value exactly equals “HSR_RELEASED_OK”; it never compares the field name.')
  await chooseOperator('Contains')
  await expect(conditionSemanticsText).toHaveText('Reads the value at outputJson.route_token and checks whether that field value contains “HSR_RELEASED_OK”; it never searches the field name.')
  await chooseOperator('Does not contain')
  await expect(conditionSemanticsText).toHaveText('Reads the value at outputJson.route_token. Matches only when that field value does not contain “HSR_RELEASED_OK”; it never searches the field name.')
  await chooseOperator('Exists')
  await expect(conditionSemanticsText).toHaveText('Matches when the JSON field at outputJson.route_token exists. It does not compare the field value.')
  await chooseOperator('Does not exist')
  await expect(conditionSemanticsText).toHaveText('Matches when the JSON field at outputJson.route_token is missing. It does not compare the field value.')
  await chooseOperator('Does not equal')
  await expect(conditionSemanticsText).toHaveText('Reads the value at outputJson.route_token. Matches only when that field value is different from “HSR_RELEASED_OK”; it never compares the field name.')
  await chooseOperator('Equals')
  await page.getByTestId('workflow-edge-condition-path-preset').click()
  await page.getByText('Entire successful reply text (output, recommended)', { exact: true }).last().click()
  await expect(conditionSemanticsText).toHaveText('Matches only when the complete reply text exactly equals “HSR_RELEASED_OK”. It does not read or compare one JSON field value.')
  await chooseOperator('Does not equal')
  await expect(conditionSemanticsText).toHaveText('Matches only when the complete reply text is different from “HSR_RELEASED_OK”. It does not read or compare one JSON field value.')
  await chooseOperator('Contains')
  await expect(conditionSemanticsText).toHaveText('Looks for “HSR_RELEASED_OK” anywhere in the complete reply text. Text in either a JSON key or a JSON value can match; this is not a JSON field lookup.')
  await chooseOperator('Does not contain')
  await expect(conditionSemanticsText).toHaveText('Matches only when “HSR_RELEASED_OK” does not appear anywhere in the complete reply text, whether in a JSON key or a JSON value. This is not a JSON field lookup.')
  await chooseOperator('Exists')
  await expect(conditionSemanticsText).toHaveText('Matches when the complete reply text is available. It does not check whether any JSON key exists.')
  await chooseOperator('Does not exist')
  await expect(conditionSemanticsText).toHaveText('Matches when no complete reply text is available. It does not check whether a JSON key is missing.')
  await chooseOperator('Equals')
  const conditionHelp = page.getByText('For success, output is recommended. Choose Route only when no content check is needed.', { exact: true })
  const operatorHelp = page.getByText('Exactly equal, including type. Example: output equals "APPROVED".', { exact: true })
  const valueTypeHelp = page.getByText('Choose how Value is parsed and validated. This editing aid is inferred from the saved JSON value and is not stored separately.', { exact: true })
  const valueHelp = page.getByText('This checks the entire reply as literal text. With Contains, the text may appear in a JSON key or value; it does not look up a JSON field.', { exact: true })
  for (const help of [conditionHelp, operatorHelp, valueTypeHelp, valueHelp]) await expect(help).toHaveCount(0)
  await page.getByTestId('workflow-edge-condition-path-help').hover()
  await expect(conditionHelp).toBeVisible()
  await edgeDialog.getByTestId('workflow-edge-operator-help').hover()
  await expect(operatorHelp).toBeVisible()
  const valueType = edgeDialog.getByTestId('workflow-edge-condition-value-type')
  await expect(valueType).toContainText('String')
  await edgeDialog.getByTestId('workflow-edge-condition-value-type-help').hover()
  await expect(valueTypeHelp).toBeVisible()
  await edgeDialog.getByTestId('workflow-edge-condition-value-help').hover()
  await expect(valueHelp).toBeVisible()
  await valueType.click()
  const objectValueTypeOption = page.locator('.n-base-select-option:visible').filter({ hasText: /^Object$/ })
  await expect(objectValueTypeOption).toHaveCount(1)
  await objectValueTypeOption.click()
  await expect(valueType).toContainText('Object')
  await expect(edgeDialog.getByTestId('workflow-edge-condition-value').locator('input')).toHaveAttribute('placeholder', 'JSON object, for example {"status":"ready"}')
  await edgeDialog.getByTestId('workflow-edge-condition-value').locator('input').fill('{')
  await expect(edgeDialog.getByTestId('workflow-edge-condition-value-error')).toHaveText('Value must be a valid object.')
  const edgeSaveButton = edgeDialog.getByRole('button', { name: 'Save', exact: true })
  await expect(edgeSaveButton).toBeDisabled()
  const activeValueInput = edgeDialog.getByTestId('workflow-edge-condition-value').locator('input')
  await activeValueInput.fill('{"status":"ready"}')
  await expect(activeValueInput).toHaveValue('{"status":"ready"}')
  await expect(edgeDialog.getByTestId('workflow-edge-condition-value-error')).toHaveCount(0)
  await expect(edgeSaveButton).toBeEnabled()
  await edgeSaveButton.click()
  await expect(page.getByText('Edit connection', { exact: true })).toHaveCount(0)

  await edge.dblclick({ force: true })
  const reopenedEdgeDialog = page.locator('.workflow-edge-editor-form').first()
  await expect(reopenedEdgeDialog.getByTestId('workflow-edge-condition-value-type')).toContainText('Object')
  await expect(reopenedEdgeDialog.getByTestId('workflow-edge-condition-value').locator('input')).toHaveValue('{"status":"ready"}')
  await reopenedEdgeDialog.getByTestId('workflow-edge-condition-operator').click()
  const greaterThanOption = page.getByText('Greater than', { exact: true }).last()
  await expect(greaterThanOption).toBeVisible()
  await greaterThanOption.click()
  const activeValueType = reopenedEdgeDialog.getByTestId('workflow-edge-condition-value-type')
  await expect(activeValueType).toContainText('Number')
  await expect(activeValueType.locator('.n-base-selection')).toHaveClass(/n-base-selection--disabled/)
  const numberOperatorHelp = page.getByText('Both actual value and Value must be JSON numbers; matches when actual is greater.', { exact: true })
  await expect(numberOperatorHelp).toHaveCount(0)
  await reopenedEdgeDialog.getByTestId('workflow-edge-operator-help').hover()
  await expect(numberOperatorHelp).toBeVisible()
  await reopenedEdgeDialog.getByTestId('workflow-edge-condition-value').locator('input').fill('42')
  await reopenedEdgeDialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()

  await edge.dblclick({ force: true })
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByTestId('workflow-edge-condition-path-preset')).toContainText('Entire successful reply text (output, recommended)')
  await expect(page.getByTestId('workflow-edge-condition-value-type')).toContainText('Number')
  await expect(page.getByTestId('workflow-edge-condition-value').locator('input')).toHaveValue('42')
  await page.getByTestId('workflow-edge-condition-operator').click({ force: true })
  await page.getByText('Exists', { exact: true }).last().click()
  await expect(page.getByTestId('workflow-edge-condition-value-type')).toHaveCount(0)
  await expect(page.getByTestId('workflow-edge-condition-value')).toHaveCount(0)
  await edgeDialog.getByRole('button', { name: 'Save', exact: true }).click()

  await edge.dispatchEvent('contextmenu', { clientX: 300, clientY: 180, button: 2 })
  await page.getByText('Edit Connection', { exact: true }).click()
  await expect(page.getByText('Edit connection', { exact: true })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.n-modal-mask:visible')).toHaveCount(0)

  const sourceHandle = page.locator('.vue-flow__node[data-id="a"] .vue-flow__handle[data-handleid="output"]')
  const canvas = page.locator('.vue-flow__pane')
  const handleBox = await sourceHandle.boundingBox()
  const canvasBox = await canvas.boundingBox()
  expect(handleBox).not.toBeNull()
  expect(canvasBox).not.toBeNull()
  const handleX = handleBox!.x + handleBox!.width / 2
  const handleY = handleBox!.y + handleBox!.height / 2
  await sourceHandle.dispatchEvent('mousedown', {
    button: 0,
    clientX: handleX,
    clientY: handleY,
  })
  await page.mouse.move(canvasBox!.x + canvasBox!.width * .72, canvasBox!.y + canvasBox!.height * .82, { steps: 8 })
  await page.mouse.up()
  await expect(page.locator('.vue-flow__node')).toHaveCount(3)
  await expect(page.locator('.vue-flow__node.selected')).toHaveCount(1)
  await expect(page.locator('.vue-flow__edge')).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0)
  await page.locator('.vue-flow__node.selected input').first().focus()
  await page.keyboard.press('Control+z')
  await expect(page.locator('.vue-flow__node')).toHaveCount(3)
  await canvas.click({ position: { x: 24, y: 24 } })
  await page.keyboard.press('Control+z')
  await expect(page.locator('.vue-flow__node')).toHaveCount(2)
  await expect(page.locator('.vue-flow__edge')).toHaveCount(1)
  expect(api.unexpectedRequests).toEqual([])
})

test('workflow nodes connect from every side and create an automatic self loop', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const nodes = [{
    id: 'review', type: 'agent', position: { x: 220, y: 100 },
    data: { title: 'Review', agent: 'hermes', input: 'Review the result', skills: [], images: [], approvalRequired: false },
  }]
  const api = await mockHermesApi(page, { workflows: [{
    id: 'wf-self-loop', name: 'Self loop workflow', profile: 'research', workspace: null,
    nodes, edges: [], viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
  }], workflowRuns: [] })
  await page.goto('/#/hermes/workflow')

  const node = page.locator('.vue-flow__node[data-id="review"]')
  await expect(page.locator('.workflow-view')).toHaveAttribute('aria-busy', 'false')
  const handles = node.locator('.workflow-handle')
  await expect(handles).toHaveCount(4)
  for (const handleId of ['input', 'top', 'output', 'bottom']) {
    const handle = node.locator(`.workflow-handle[data-handleid="${handleId}"]`)
    await expect(handle).toHaveCount(1)
    await expect(handle).toHaveClass(/connectablestart/)
    await expect(handle).toHaveClass(/connectableend/)
  }

  const rightHandle = node.locator('.workflow-handle[data-handleid="output"]')
  const topHandle = node.locator('.workflow-handle[data-handleid="top"]')
  const rightBox = await rightHandle.boundingBox()
  const topBox = await topHandle.boundingBox()
  expect(rightBox).not.toBeNull()
  expect(topBox).not.toBeNull()
  await page.mouse.move(rightBox!.x + rightBox!.width / 2, rightBox!.y + rightBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(topBox!.x + topBox!.width / 2, topBox!.y + topBox!.height / 2, { steps: 12 })
  await page.mouse.up()

  const selfLoop = page.locator('.vue-flow__edge[data-id="review-review"]')
  await expect(selfLoop).toHaveCount(1)
  await expect(selfLoop).toHaveClass(/vue-flow__edge-workflow-self-loop/)
  await expect(page.locator('[data-testid="workflow-edge-condition-label"][data-edge-id="review-review"]')).toHaveText('Source returned normally')
  const selfLoopPath = selfLoop.locator('.vue-flow__edge-interaction')
  await expect(selfLoop.locator('.vue-flow__edge-path')).toHaveAttribute('d', /M\s/)
  const selfLoopCrossesNode = await selfLoop.locator('.vue-flow__edge-path').evaluate((path: SVGPathElement) => {
    const matrix = path.getScreenCTM()!
    const length = path.getTotalLength()
    const nodeRect = document.querySelector('.vue-flow__node[data-id="review"]')!.getBoundingClientRect()
    for (let step = 1; step < 40; step += 1) {
      const point = path.getPointAtLength(length * step / 40)
      const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix)
      if (
        screen.x > nodeRect.left + 1 && screen.x < nodeRect.right - 1
        && screen.y > nodeRect.top + 1 && screen.y < nodeRect.bottom - 1
      ) return true
    }
    return false
  })
  expect(selfLoopCrossesNode).toBe(false)
  const loopPoint = await selfLoopPath.evaluate((path: SVGPathElement) => {
    const matrix = path.getScreenCTM()!
    const length = path.getTotalLength()
    for (let step = 1; step < 20; step += 1) {
      const point = path.getPointAtLength(length * step / 20)
      const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix)
      const hit = document.elementFromPoint(screen.x, screen.y)?.closest('.vue-flow__edge')
      if (hit?.getAttribute('data-id') === 'review-review') return { x: screen.x, y: screen.y }
    }
    return null
  })
  expect(loopPoint).not.toBeNull()
  if (!loopPoint) throw new Error('self-loop interaction point not found')
  await page.mouse.dblclick(loopPoint.x, loopPoint.y)

  const editor = page.locator('.workflow-edge-editor-form').first()
  await expect(editor.getByTestId('workflow-edge-connection-summary')).toContainText('Review → Review')
  await expect(editor.getByTestId('workflow-edge-connection-summary')).toContainText('Review will run itself again')
  await expect(editor.getByTestId('workflow-edge-loop-summary')).toContainText('Returns to Review')
  await expect(editor.getByTestId('workflow-edge-loop-scope')).toContainText('Loop nodes: Review')
  await expect(editor.getByText('Feedback loop', { exact: true })).toHaveCount(0)
  await expect(editor.getByTestId('workflow-edge-loop-node')).toHaveCount(0)
  await editor.getByText('Advanced settings', { exact: true }).click()
  const historyNode = editor.getByTestId('workflow-edge-loop-node')
  await expect(historyNode).toBeVisible()
  await expect(historyNode.locator('input')).toHaveCount(0)
  await historyNode.click()
  await page.getByText('Review', { exact: true }).last().click()
  await editor.getByRole('button', { name: 'Save', exact: true }).click()

  const patchCount = api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/studio/workflows/wf-self-loop').length
  await page.locator('.header-actions').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/studio/workflows/wf-self-loop').length).toBe(patchCount + 1)
  const saved = JSON.parse(api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/studio/workflows/wf-self-loop').at(-1)!.postData || '{}')
  expect(saved.edges).toEqual([expect.objectContaining({
    id: 'review-review', source: 'review', target: 'review',
    sourceHandle: 'output', targetHandle: 'top', type: 'workflow-self-loop',
    data: { orchestration: { route: 'success', feedback: { maxIterations: 3, loopId: 'review' } } },
  })])
  expect(saved.edges[0]).not.toHaveProperty('class')
  expect(saved.edges[0]).not.toHaveProperty('animated')
  expect(api.unexpectedRequests).toEqual([])
})

test('workflow edge editor never exposes technical node ids when node titles are blank', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const technicalNodeId = '11111111-1111-4111-8111-111111111111'
  const edgeId = 'blank-title-loop'
  const sessionId = 'blank-title-session'
  const session = {
    id: sessionId, title: 'Blank title session', source: 'cli', model: 'test-model', provider: 'test-provider',
    profile: 'research', started_at: 1, ended_at: 2, last_active: 2, message_count: 0, tool_call_count: 0,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
    billing_provider: null, estimated_cost_usd: 0, actual_cost_usd: null, cost_status: 'unavailable',
    messages: [],
  }
  const api = await mockHermesApi(page, { workflows: [{
    id: 'wf-blank-title-loop', name: 'Blank title loop', profile: 'research', workspace: null,
    nodes: [{
      id: technicalNodeId, type: 'agent', position: { x: 220, y: 100 },
      data: { title: '   ', agent: 'hermes', input: 'Review', skills: [], images: [], approvalRequired: false },
    }],
    edges: [{
      id: edgeId, source: technicalNodeId, target: technicalNodeId,
      sourceHandle: 'output', targetHandle: 'top', type: 'workflow-self-loop',
      data: { orchestration: { route: 'success', feedback: { maxIterations: 3 } } },
    }],
    viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
  }], workflowRuns: [{
    id: 'run-blank-title', workflow_id: 'wf-blank-title-loop', profile: 'research', workspace: null,
    start_node_ids: [technicalNodeId], status: 'completed', snapshot_nodes: [{ id: technicalNodeId, data: { title: '   ' } }],
    snapshot_edges: [], compiled_loops: [], started_at: 1, finished_at: 2, created_at: 1, error: null,
    node_sessions: [{
      id: 'blank-title-node-session', run_id: 'run-blank-title', workflow_id: 'wf-blank-title-loop',
      node_id: technicalNodeId, execution_id: technicalNodeId, iteration_path: [], consumed_edge_evaluation_ids: [],
      session_id: sessionId, profile: 'research', agent: 'hermes', agent_mode: '', status: 'completed', sequence: 1,
      started_at: 1, finished_at: 2, created_at: 1, updated_at: 2, error: null,
    }],
    edge_evaluations: [], loop_epochs: [],
  }], sessions: [session] })
  await page.route(`**/api/studio/sessions/${sessionId}**`, route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ session }),
  }))
  await mockChatSocket(page)

  await page.goto('/#/hermes/workflow')
  await page.locator(`[data-testid="workflow-edge-condition-label"][data-edge-id="${edgeId}"]`).dblclick()
  const editor = page.locator('.workflow-edge-editor-form').first()
  await expect(editor).toBeVisible()
  await expect(editor.getByTestId('workflow-edge-connection-summary')).toContainText('Unknown node → Unknown node')
  await expect(editor.getByTestId('workflow-edge-loop-summary')).toContainText('Unknown node')
  await expect(editor.getByTestId('workflow-edge-loop-scope')).toContainText('Unknown node')
  await expect(editor).not.toContainText(technicalNodeId)

  await editor.getByText('Advanced settings', { exact: true }).click()
  const historyNode = editor.getByTestId('workflow-edge-loop-node')
  await historyNode.click()
  const option = page.getByText('Unknown node', { exact: true }).last()
  await expect(option).toBeVisible()
  await expect(page.locator('.n-base-select-menu:visible')).not.toContainText(technicalNodeId)
  await option.click()
  await expect(historyNode).toContainText('Unknown node')
  await expect(editor).not.toContainText(technicalNodeId)
  await page.keyboard.press('Escape')
  await expect(editor).toBeHidden()

  await page.locator('.workflow-run-item').click()
  await page.locator(`.vue-flow__node[data-id="${technicalNodeId}"]`).click()
  const chatTitle = page.locator('.workflow-chat-title')
  await expect(chatTitle).toContainText('Unknown node')
  await expect(chatTitle).not.toContainText(technicalNodeId)

  const workflowBody = page.locator('.workflow-body')
  const chatPanel = page.locator('.workflow-chat-panel')
  const resizeHandle = page.locator('.workflow-chat-resize-handle')
  const geometry = async () => {
    const [body, panel, handle] = await Promise.all([
      workflowBody.boundingBox(),
      chatPanel.boundingBox(),
      resizeHandle.boundingBox(),
    ])
    expect(body).not.toBeNull()
    expect(panel).not.toBeNull()
    expect(handle).not.toBeNull()
    return { body: body!, panel: panel!, handle: handle! }
  }

  const ltr = await geometry()
  expect(Math.abs(ltr.panel.x - ltr.body.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(ltr.handle.x + ltr.handle.width / 2 - (ltr.panel.x + ltr.panel.width))).toBeLessThanOrEqual(1)
  await page.mouse.move(ltr.handle.x + ltr.handle.width / 2, ltr.handle.y + ltr.handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(ltr.handle.x + ltr.handle.width / 2 - 32, ltr.handle.y + ltr.handle.height / 2)
  await page.mouse.up()
  await expect.poll(async () => (await chatPanel.boundingBox())!.width).toBeLessThan(ltr.panel.width - 20)

  await page.locator('html').evaluate(element => element.setAttribute('dir', 'rtl'))
  await expect.poll(async () => {
    const { body, panel } = await geometry()
    return Math.abs(panel.x + panel.width - (body.x + body.width)) <= 1
  }).toBe(true)
  const rtl = await geometry()
  expect(Math.abs(rtl.handle.x + rtl.handle.width / 2 - rtl.panel.x)).toBeLessThanOrEqual(1)
  await page.mouse.move(rtl.handle.x + rtl.handle.width / 2, rtl.handle.y + rtl.handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(rtl.handle.x + rtl.handle.width / 2 + 32, rtl.handle.y + rtl.handle.height / 2)
  await page.mouse.up()
  await expect.poll(async () => (await chatPanel.boundingBox())!.width).toBeLessThan(rtl.panel.width - 20)

  expect(api.unexpectedRequests).toEqual([])
})

test('opposite-side self loops use measured node bounds in the rendered SVG', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const feedback = { orchestration: { route: 'success', feedback: { maxIterations: 3 } } }
  const nodes = [
    {
      id: 'horizontal', type: 'agent', position: { x: 180, y: 180 }, style: { width: '480px', height: '260px' },
      data: { title: 'Horizontal', agent: 'hermes', input: 'Horizontal loop', skills: [], images: [], approvalRequired: false },
    },
    {
      id: 'vertical', type: 'agent', position: { x: 900, y: 120 }, style: { width: '360px', height: '480px' },
      data: { title: 'Vertical', agent: 'hermes', input: 'Vertical loop', skills: [], images: [], approvalRequired: false },
    },
  ]
  const edges = [
    {
      id: 'horizontal-horizontal', source: 'horizontal', target: 'horizontal',
      sourceHandle: 'input', targetHandle: 'output', type: 'workflow-self-loop', data: feedback,
    },
    {
      id: 'vertical-vertical', source: 'vertical', target: 'vertical',
      sourceHandle: 'top', targetHandle: 'bottom', type: 'workflow-self-loop', data: feedback,
    },
  ]
  const api = await mockHermesApi(page, { workflows: [{
    id: 'wf-opposite-loops', name: 'Opposite loops', profile: 'research', workspace: null,
    nodes, edges, viewport: { x: 80, y: 80, zoom: .4 }, created_at: 1, updated_at: 1,
  }], workflowRuns: [] })
  await page.goto('/#/hermes/workflow')

  for (const nodeId of ['horizontal', 'vertical']) {
    await expect(page.locator('.workflow-view')).toHaveAttribute('aria-busy', 'false')
    const result = await page.locator(`.vue-flow__edge[data-id="${nodeId}-${nodeId}"] .vue-flow__edge-path`)
      .evaluate((path: SVGPathElement, currentNodeId) => {
        const matrix = path.getScreenCTM()!
        const length = path.getTotalLength()
        const nodeRect = document.querySelector(`.vue-flow__node[data-id="${currentNodeId}"]`)!.getBoundingClientRect()
        let inside = 0
        let hit = 0
        for (let step = 1; step < 80; step += 1) {
          const point = path.getPointAtLength(length * step / 80)
          const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix)
          if (
            screen.x > nodeRect.left + 1 && screen.x < nodeRect.right - 1
            && screen.y > nodeRect.top + 1 && screen.y < nodeRect.bottom - 1
          ) inside += 1
          const hitElement = document.elementFromPoint(screen.x, screen.y)
          const hitEdge = hitElement?.closest('.vue-flow__edge')
          const hitLabel = hitElement?.closest('[data-testid="workflow-edge-condition-label"]')
          if (
            hitEdge?.getAttribute('data-id') === `${currentNodeId}-${currentNodeId}`
            || hitLabel?.getAttribute('data-edge-id') === `${currentNodeId}-${currentNodeId}`
          ) hit += 1
        }
        return { d: path.getAttribute('d'), inside, hit }
      }, nodeId)
    expect(result.d).toMatch(/^M\s/)
    expect(result.inside, `${nodeId}: ${result.d}`).toBe(0)
    expect(result.hit, `${nodeId}: ${result.d}`).toBe(79)
  }
  expect(api.unexpectedRequests).toEqual([])
})

test('workflow loop validation blocks invalid editor and workflow saves before API writes', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const nodes = [
    { id: 'a', type: 'agent', position: { x: 0, y: 20 }, data: { title: 'A', agent: 'hermes', input: 'A', skills: [], images: [], approvalRequired: false } },
    { id: 'b', type: 'agent', position: { x: 360, y: 20 }, data: { title: 'B', agent: 'hermes', input: 'B', skills: [], images: [], approvalRequired: false } },
    { id: 'c', type: 'agent', position: { x: 0, y: 640 }, data: { title: 'C', agent: 'hermes', input: 'C', skills: [], images: [], approvalRequired: false } },
    { id: 'd', type: 'agent', position: { x: 360, y: 640 }, data: { title: 'D', agent: 'hermes', input: 'D', skills: [], images: [], approvalRequired: false } },
  ]
  const feedback = (loopId: string) => ({ orchestration: { route: 'success', feedback: { maxIterations: 3, loopId } } })
  const edges = [
    { id: 'a-b', source: 'a', target: 'b', type: 'smoothstep' },
    { id: 'b-a', source: 'b', target: 'a', type: 'smoothstep', data: feedback('retry') },
    { id: 'b-c', source: 'b', target: 'c', type: 'smoothstep' },
    { id: 'c-d', source: 'c', target: 'd', type: 'smoothstep' },
    { id: 'd-c', source: 'd', target: 'c', type: 'smoothstep', data: feedback('retry') },
  ]
  const api = await mockHermesApi(page, { workflows: [{
    id: 'wf-invalid-loops', name: 'Invalid loops', profile: 'research', workspace: null,
    nodes, edges, viewport: { x: 80, y: 80, zoom: .65 }, created_at: 1, updated_at: 1,
  }], workflowRuns: [] })
  await page.goto('/#/hermes/workflow')

  const patchCount = api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/studio/workflows/wf-invalid-loops').length
  await page.locator('.header-actions').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Each loop history label must be unique.', { exact: true }).last()).toBeVisible()
  await page.waitForTimeout(100)
  expect(api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/studio/workflows/wf-invalid-loops')).toHaveLength(patchCount)

  const feedbackEdge = page.locator('.vue-flow__edge[data-id="b-a"]')
  await expect(page.locator('.workflow-view')).toHaveAttribute('aria-busy', 'false')
  await feedbackEdge.dblclick({ force: true })
  const edgeDialog = page.locator('.workflow-edge-editor-form').first()
  await expect(edgeDialog).toBeVisible()
  await edgeDialog.getByText('Advanced settings', { exact: true }).click()
  const historyNode = edgeDialog.getByTestId('workflow-edge-loop-node')
  await expect(historyNode).toContainText('A')
  await expect(historyNode).not.toContainText('retry')
  await edgeDialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(edgeDialog).toBeHidden()

  await page.locator('.header-actions').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/studio/workflows/wf-invalid-loops').length).toBe(patchCount + 1)
  const saved = JSON.parse(api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/studio/workflows/wf-invalid-loops').at(-1)!.postData || '{}')
  expect(saved.edges.find((edge: { id: string }) => edge.id === 'b-a').data.orchestration.feedback.loopId).toBe('a')
  expect(saved.edges.find((edge: { id: string }) => edge.id === 'd-c').data.orchestration.feedback.loopId).toBe('retry')
  expect(api.unexpectedRequests).toEqual([])
})


test('workflow execution details explain an upstream business blocker before raw routing codes', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const nodes = [
    { id: 'publish', type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Publish release', agent: 'hermes', input: 'Publish', skills: [], images: [], approvalRequired: false } },
    { id: 'verify', type: 'agent', position: { x: 420, y: 80 }, data: { title: 'Verify release', agent: 'hermes', input: 'Verify', skills: [], images: [], approvalRequired: false } },
    { id: 'fallback', type: 'agent', position: { x: 420, y: 260 }, data: { title: 'Notify fallback', agent: 'hermes', input: 'Notify', skills: [], images: [], approvalRequired: false } },
  ]
  const edges = [
    { id: 'publish-verify', source: 'publish', target: 'verify', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'contains', value: 'PUBLISHED' } } } },
    { id: 'publish-fallback', source: 'publish', target: 'fallback', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'failure' } } },
  ]
  await mockHermesApi(page, { workflows: [{
    id: 'wf-release', name: 'Release workflow', profile: 'research', workspace: null,
    nodes, edges, viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
  }], workflowRuns: [{
    id: 'run-blocked', workflow_id: 'wf-release', profile: 'research', workspace: null, start_node_ids: ['publish'], status: 'completed',
    snapshot_nodes: nodes, snapshot_edges: edges, compiled_loops: [], started_at: 1, finished_at: 2, created_at: 1, error: null,
    node_sessions: [],
    edge_evaluations: [{
      id: 'evaluation-1', run_id: 'run-blocked', workflow_id: 'wf-release', edge_id: 'publish-verify',
      source_node_id: 'publish', source_execution_id: 'publish', iteration_path: [], target_node_id: 'verify',
      source_outcome: 'success', status: 'not_taken', route: 'success', reason: 'condition_not_matched', sequence: 1,
      orchestration: { route: 'success', condition: { path: 'output', operator: 'contains', value: 'PUBLISHED' } },
      condition_evaluation: { status: 'not_matched', reason: 'not_equal', actual: '\n```json\n{"decision":"BLOCKED","route_marker":"BLOCKED","reason":"The release lock was missing before publication."}\n```' },
      evaluated_at: 2,
    }, {
      id: 'evaluation-2', run_id: 'run-blocked', workflow_id: 'wf-release', edge_id: 'publish-fallback',
      source_node_id: 'publish', source_execution_id: 'publish', iteration_path: [], target_node_id: 'fallback',
      source_outcome: 'success', status: 'not_taken', route: 'failure', reason: 'route_not_matched', sequence: 2,
      orchestration: { route: 'failure' },
      condition_evaluation: { actual: JSON.stringify({ decision: 'BLOCKED', reason: 'The release lock was missing before publication.' }) },
      evaluated_at: 2,
    }],
    loop_epochs: [],
  }] })

  await page.goto('/#/hermes/workflow')
  await page.locator('.workflow-run-item').click()
  const evidence = page.getByLabel('Workflow execution details')
  const overview = evidence.getByTestId('workflow-evidence-overview')
  await expect(overview.getByText('Status', { exact: true })).toBeVisible()
  await expect(overview.getByText('Blocked', { exact: true })).toBeVisible()
  await expect(overview).not.toContainText('BLOCKED')
  await expect(overview.getByText('The release lock was missing before publication.', { exact: true })).toHaveCount(0)
  await evidence.getByRole('tab', { name: 'Other judgments 2' }).click()

  const blockerText = 'Publish release stopped the workflow (Blocked): The release lock was missing before publication. Continuing required “PUBLISHED”, but the upstream result was “Blocked”, so “Verify release” was not run.'
  await expect(evidence.getByText('Condition did not match', { exact: true })).toBeVisible()
  await expect(evidence.getByText('not_taken', { exact: true })).toHaveCount(0)
  const blockerRow = evidence.locator('.workflow-evidence-row').filter({ hasText: 'Publish release → Verify release' })
  await blockerRow.getByRole('button', { name: /Connection judgment/ }).click()
  const detailModal = page.getByTestId('workflow-evidence-detail-modal')
  await expect(detailModal).toBeVisible()
  await expect(detailModal.getByText(blockerText, { exact: true })).toBeVisible()
  await expect(detailModal.getByText('This connection was not used', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('Only when the upstream node returns normally', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('The reply did not satisfy this connection’s condition.', { exact: true })).toBeVisible()
  await expect(detailModal).not.toContainText('not_taken')
  await expect(detailModal).not.toContainText('condition_not_matched')
  await expect(detailModal.getByText('PUBLISHED', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('Blocked', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('BLOCKED', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(evidence.getByText('The source node returned normally; this path is only used when node execution fails.', { exact: true })).toBeVisible()
})

test('workflow business decisions use exact mappings and never invert unknown codes', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const nodes = [
    { id: 'source', type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Source', agent: 'hermes', input: 'Source', skills: [], images: [], approvalRequired: false } },
    { id: 'target', type: 'agent', position: { x: 420, y: 80 }, data: { title: 'Target', agent: 'hermes', input: 'Target', skills: [], images: [], approvalRequired: false } },
  ]
  const edge = { id: 'source-target', source: 'source', target: 'target', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'success' } } }
  const decisions = ['UNBLOCKED', 'NOT_PUBLISHED', 'UNVERIFIED', 'DO_NOT_SKIP', 'CUSTOM_INTERNAL_CODE']
  await mockHermesApi(page, {
    workflows: [{ id: 'wf-decisions', name: 'Decision workflow', profile: 'research', workspace: null, nodes, edges: [edge], viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1 }],
    workflowRuns: decisions.map((decision, index) => ({
      id: `run-${decision}`, workflow_id: 'wf-decisions', profile: 'research', workspace: null, start_node_ids: ['source'], status: 'completed',
      snapshot_nodes: nodes, snapshot_edges: [edge], compiled_loops: [], started_at: index + 1, finished_at: index + 2, created_at: index + 1, error: null,
      node_sessions: [], edge_evaluations: [{
        id: `evaluation-${decision}`, run_id: `run-${decision}`, workflow_id: 'wf-decisions', edge_id: 'source-target',
        source_node_id: 'source', source_execution_id: 'source', iteration_path: [], target_node_id: 'target', source_outcome: 'success',
        status: 'taken', route: 'success', reason: null, sequence: 1, orchestration: { route: 'success' },
        condition_evaluation: { actual: JSON.stringify({ decision }) }, evaluated_at: index + 2,
      }], loop_epochs: [],
    })),
  })

  await page.goto('/#/hermes/workflow')
  const runs = page.locator('.workflow-run-item')
  for (let index = 0; index < decisions.length; index += 1) {
    await runs.nth(index).click()
    const overview = page.getByTestId('workflow-evidence-overview')
    await expect(overview).toContainText('Completed')
    await expect(overview).not.toContainText(decisions[index])
    await expect(overview).not.toContainText('Blocked')
    await expect(overview).not.toContainText('Published')
    await expect(overview).not.toContainText('Verified')
    await expect(overview).not.toContainText('No action needed')
    await page.getByTestId('workflow-run-back').click()
  }
})

test('workflow history localizes structured decision field values without hiding ordinary JSON operands', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const nodes = [
    { id: 'source', type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Source', agent: 'hermes', input: 'Source', skills: [], images: [], approvalRequired: false } },
    { id: 'target', type: 'agent', position: { x: 420, y: 80 }, data: { title: 'Target', agent: 'hermes', input: 'Target', skills: [], images: [], approvalRequired: false } },
    { id: 'gate', type: 'agent', position: { x: 420, y: 260 }, data: { title: 'Gate', agent: 'hermes', input: 'Gate', skills: [], images: [], approvalRequired: false } },
  ]
  const edges = [
    { id: 'source-target', source: 'source', target: 'target', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'success', condition: { path: 'outputJson.decision', operator: 'equals', value: 'PUBLISHED' } } } },
    { id: 'source-gate', source: 'source', target: 'gate', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'success', condition: { path: 'outputJson.failed_gate', operator: 'equals', value: 'release' } } } },
  ]
  await mockHermesApi(page, {
    workflows: [{ id: 'wf-structured-decision', name: 'Structured decision workflow', profile: 'research', workspace: null, nodes, edges, viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1 }],
    workflowRuns: [{
      id: 'run-structured-decision', workflow_id: 'wf-structured-decision', profile: 'research', workspace: null, start_node_ids: ['source'], status: 'completed',
      snapshot_nodes: nodes, snapshot_edges: edges, compiled_loops: [], started_at: 1, finished_at: 2, created_at: 1, error: null, node_sessions: [],
      edge_evaluations: [{
        id: 'evaluation-decision', run_id: 'run-structured-decision', workflow_id: 'wf-structured-decision', edge_id: 'source-target',
        source_node_id: 'source', source_execution_id: 'source', iteration_path: [], target_node_id: 'target', source_outcome: 'success',
        status: 'not_taken', route: 'success', reason: 'future_internal_reason', sequence: 1, orchestration: edges[0].data.orchestration,
        condition_evaluation: { status: 'not_matched', actual: 'BLOCKED' }, evaluated_at: 2,
      }, {
        id: 'evaluation-gate', run_id: 'run-structured-decision', workflow_id: 'wf-structured-decision', edge_id: 'source-gate',
        source_node_id: 'source', source_execution_id: 'source', iteration_path: [], target_node_id: 'gate', source_outcome: 'success',
        status: 'not_taken', route: 'success', reason: 'condition_not_matched', sequence: 2, orchestration: edges[1].data.orchestration,
        condition_evaluation: { status: 'not_matched', actual: 'image-build' }, evaluated_at: 2,
      }], loop_epochs: [],
    }],
  })

  await page.goto('/#/hermes/workflow')
  await page.locator('.workflow-run-item').click()
  const evidence = page.getByLabel('Workflow execution details')
  await evidence.getByRole('tab', { name: 'Other judgments 2' }).click()
  const decisionRow = evidence.locator('.workflow-evidence-row').filter({ hasText: 'Source → Target' })
  await expect(decisionRow).toContainText('Did not match')
  await expect(decisionRow).not.toContainText('BLOCKED')
  await decisionRow.getByRole('button', { name: /Connection judgment/ }).click()
  const detailModal = page.getByTestId('workflow-evidence-detail-modal')
  await expect(detailModal).toBeVisible()
  await expect(detailModal.getByText('Blocked', { exact: true })).toBeVisible()
  await expect(detailModal).not.toContainText('BLOCKED')
  await expect(detailModal).not.toContainText('future_internal_reason')
  await detailModal.getByRole('button', { name: 'Close' }).click()
  const gateRow = evidence.locator('.workflow-evidence-row').filter({ hasText: 'Source → Gate' })
  await gateRow.getByRole('button', { name: /Connection judgment/ }).click()
  await expect(detailModal.getByText('Actual upstream result', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('image-build', { exact: true })).toBeVisible()
})

test('workflow history never exposes technical ids when snapshot node titles are missing', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const sourceId = '11111111-1111-4111-8111-111111111111'
  const targetId = '22222222-2222-4222-8222-222222222222'
  const nodes = [
    { id: sourceId, type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Source', agent: 'hermes', input: 'Source', skills: [], images: [], approvalRequired: false } },
    { id: targetId, type: 'agent', position: { x: 420, y: 80 }, data: { title: 'Target', agent: 'hermes', input: 'Target', skills: [], images: [], approvalRequired: false } },
  ]
  const edge = { id: '33333333-3333-4333-8333-333333333333', source: sourceId, target: targetId, sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'success' } } }
  await mockHermesApi(page, {
    workflows: [{ id: 'wf-missing-titles', name: 'Missing titles workflow', profile: 'research', workspace: null, nodes, edges: [edge], viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1 }],
    workflowRuns: [{
      id: 'run-missing-titles', workflow_id: 'wf-missing-titles', profile: 'research', workspace: null, start_node_ids: [sourceId], status: 'completed',
      snapshot_nodes: [{ id: sourceId, data: {} }, { id: targetId, data: {} }], snapshot_edges: [edge], compiled_loops: [],
      started_at: 1, finished_at: 2, created_at: 1, error: null, node_sessions: [],
      edge_evaluations: [{
        id: 'evaluation-missing-titles', run_id: 'run-missing-titles', workflow_id: 'wf-missing-titles', edge_id: edge.id,
        source_node_id: sourceId, source_execution_id: sourceId, iteration_path: [], target_node_id: targetId, source_outcome: 'success',
        status: 'taken', route: 'success', reason: null, sequence: 1, orchestration: edge.data.orchestration,
        condition_evaluation: null, evaluated_at: 2,
      }], loop_epochs: [],
    }],
  })

  await page.goto('/#/hermes/workflow')
  await page.locator('.workflow-run-item').click()
  const row = page.getByLabel('Workflow execution details').locator('.workflow-evidence-row').first()
  await expect(row).toContainText('Unknown node → Unknown node')
  await expect(row).not.toContainText(sourceId)
  await expect(row).not.toContainText(targetId)
  await row.getByRole('button', { name: /Connection judgment/ }).click()
  const modal = page.getByTestId('workflow-evidence-detail-modal')
  await expect(modal).toContainText('Unknown node → Unknown node')
  await expect(modal).not.toContainText(sourceId)
  await expect(modal).not.toContainText(targetId)
})

test('workflow history explains raw-text and JSON-field existence checks separately', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const nodes = [
    { id: 'source', type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Source', agent: 'hermes', input: 'Source', skills: [], images: [], approvalRequired: false } },
    ...['raw-exists', 'raw-missing', 'json-exists', 'json-missing'].map((id, index) => ({
      id, type: 'agent', position: { x: 420, y: 40 + index * 140 },
      data: { title: id, agent: 'hermes', input: id, skills: [], images: [], approvalRequired: false },
    })),
  ]
  const conditions = [
    { id: 'raw-exists', path: 'output', operator: 'exists', status: 'taken', evaluation: { status: 'matched', actual: 'reply' } },
    { id: 'raw-missing', path: 'output', operator: 'not_exists', status: 'not_taken', evaluation: { status: 'not_matched', actual: 'reply' } },
    { id: 'json-exists', path: 'outputJson.failed_gate', operator: 'exists', status: 'taken', evaluation: { status: 'matched', actual: 'quality' } },
    { id: 'json-missing', path: 'outputJson.failed_gate', operator: 'not_exists', status: 'not_taken', evaluation: { status: 'not_matched', reason: 'path_not_found' } },
  ] as const
  const edges = conditions.map(item => ({
    id: `source-${item.id}`, source: 'source', target: item.id, sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep',
    data: { orchestration: { route: 'success', condition: { path: item.path, operator: item.operator } } },
  }))
  await mockHermesApi(page, {
    workflows: [{ id: 'wf-existence', name: 'Existence workflow', profile: 'research', workspace: null, nodes, edges, viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1 }],
    workflowRuns: [{
      id: 'run-existence', workflow_id: 'wf-existence', profile: 'research', workspace: null, start_node_ids: ['source'], status: 'completed',
      snapshot_nodes: nodes, snapshot_edges: edges, compiled_loops: [], started_at: 1, finished_at: 2, created_at: 1, error: null, node_sessions: [],
      edge_evaluations: conditions.map((item, index) => ({
        id: `evaluation-${item.id}`, run_id: 'run-existence', workflow_id: 'wf-existence', edge_id: `source-${item.id}`,
        source_node_id: 'source', source_execution_id: 'source', iteration_path: [], target_node_id: item.id, source_outcome: 'success',
        status: item.status, route: 'success', reason: item.status === 'taken' ? null : 'condition_not_matched', sequence: index + 1,
        orchestration: edges[index].data.orchestration, condition_evaluation: item.evaluation, evaluated_at: 2,
      })),
      loop_epochs: [],
    }],
  })

  await page.goto('/#/hermes/workflow')
  await page.locator('.workflow-run-item').click()
  const evidence = page.getByLabel('Workflow execution details')
  const row = (title: string) => evidence.locator('.workflow-evidence-row').filter({ hasText: `Source → ${title}` })
  await expect(row('raw-exists')).toContainText('Executed')
  await expect(row('json-exists')).toContainText('Executed')
  await evidence.getByRole('tab', { name: 'Other judgments 2' }).click()
  await expect(row('raw-missing')).toContainText('Did not match')
  await expect(row('json-missing')).toContainText('Did not match')
  await row('json-missing').getByRole('button', { name: /Connection judgment/ }).click()
  const detailModal = page.getByTestId('workflow-evidence-detail-modal')
  await expect(detailModal.getByText('Checked data', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('One JSON field value', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('Does not exist', { exact: true })).toBeVisible()
})


test('workflow execution details lead with the business outcome, chosen path, and explicit condition comparisons', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const nodes = [
    { id: 'publish', type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Build and publish', agent: 'hermes', input: 'Publish', skills: [], images: [], approvalRequired: false } },
    { id: 'verify', type: 'agent', position: { x: 420, y: 40 }, data: { title: 'Verify release', agent: 'hermes', input: 'Verify', skills: [], images: [], approvalRequired: false } },
    { id: 'blocked', type: 'agent', position: { x: 420, y: 240 }, data: { title: 'Blocked outcome', agent: 'hermes', input: 'Explain blocker', skills: [], images: [], approvalRequired: false } },
    { id: 'summary', type: 'agent', position: { x: 760, y: 140 }, data: { title: 'Plain-language summary', agent: 'hermes', input: 'Summarize', skills: [], images: [], approvalRequired: false } },
  ]
  const edges = [
    { id: 'publish-verify', source: 'publish', target: 'verify', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'contains', value: 'HSR_RELEASED_OK' } } } },
    { id: 'publish-blocked', source: 'publish', target: 'blocked', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'success', condition: { path: 'output', operator: 'contains', value: 'failed_gate' } } } },
    { id: 'publish-summary', source: 'publish', target: 'summary', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'failure', condition: { path: 'error', operator: 'contains', value: 'fatal' } } } },
    { id: 'verify-summary', source: 'verify', target: 'summary', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'always' } } },
    { id: 'blocked-summary', source: 'blocked', target: 'summary', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep', data: { orchestration: { route: 'always' } } },
  ]
  const blockedOutput = JSON.stringify({
    decision: 'BLOCKED',
    failed_gate: 'quality-container-setup',
    reason: 'The container workdir did not exist before the first command.',
    side_effects_completed: [],
  })
  const evaluation = (input: Record<string, unknown>) => ({
    id: `evaluation-${input.sequence}`, run_id: 'run-blocked-overview', workflow_id: 'wf-release-overview',
    source_execution_id: input.source_node_id, iteration_path: [], evaluated_at: 2,
    condition_evaluation: null, ...input,
  })
  await mockHermesApi(page, { workflows: [{
    id: 'wf-release-overview', name: 'Release workflow', profile: 'research', workspace: null,
    nodes, edges, viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
  }], workflowRuns: [{
    id: 'run-blocked-overview', workflow_id: 'wf-release-overview', profile: 'research', workspace: null, start_node_ids: ['publish'], status: 'completed',
    snapshot_nodes: nodes, snapshot_edges: edges, compiled_loops: [], started_at: 1, finished_at: 2, created_at: 1, error: null,
    node_sessions: [],
    edge_evaluations: [
      evaluation({ edge_id: 'publish-verify', source_node_id: 'publish', target_node_id: 'verify', source_outcome: 'success', status: 'not_taken', route: 'success', reason: 'condition_not_matched', sequence: 1, orchestration: edges[0].data.orchestration, condition_evaluation: { status: 'not_matched', reason: 'not_equal', actual: blockedOutput } }),
      evaluation({ edge_id: 'publish-blocked', source_node_id: 'publish', target_node_id: 'blocked', source_outcome: 'success', status: 'taken', route: 'success', reason: null, sequence: 2, orchestration: edges[1].data.orchestration, condition_evaluation: { status: 'matched', actual: blockedOutput } }),
      evaluation({ edge_id: 'publish-summary', source_node_id: 'publish', target_node_id: 'summary', source_outcome: 'success', status: 'not_taken', route: 'failure', reason: 'route_not_matched', sequence: 3, orchestration: edges[2].data.orchestration }),
      evaluation({ edge_id: 'verify-summary', source_node_id: 'verify', target_node_id: 'summary', source_outcome: 'skipped', status: 'not_taken', route: 'always', reason: 'route_not_matched', sequence: 4, orchestration: edges[3].data.orchestration }),
      evaluation({ edge_id: 'blocked-summary', source_node_id: 'blocked', target_node_id: 'summary', source_outcome: 'success', status: 'taken', route: 'always', reason: null, sequence: 5, orchestration: edges[4].data.orchestration }),
    ],
    loop_epochs: [],
  }] })

  await page.goto('/#/hermes/workflow')
  await page.locator('.workflow-run-item').click()
  const evidence = page.getByLabel('Workflow execution details')
  const overview = evidence.getByTestId('workflow-evidence-overview')
  await expect(overview.getByText('Status', { exact: true })).toBeVisible()
  await expect(overview.getByText('Blocked', { exact: true })).toBeVisible()
  await expect(overview).not.toContainText('BLOCKED')
  await expect(overview).not.toContainText('quality-container-setup')
  await expect(overview).not.toContainText('The container workdir did not exist before the first command.')
  const actualPath = overview.getByTestId('workflow-actual-path-compact')
  await expect(actualPath).toContainText('Build and publish → Blocked outcome')
  await expect(actualPath).toContainText('Blocked outcome → Plain-language summary')
  await expect(actualPath).not.toContainText('Verify release')

  const tabs = evidence.getByTestId('workflow-evidence-tabs')
  await expect(tabs.getByRole('tab', { name: 'Executed 2' })).toBeVisible()
  await expect(tabs.getByRole('tab', { name: 'Other judgments 3' })).toBeVisible()
  await expect(tabs.getByRole('tab', { name: 'Loop events 0' })).toBeVisible()
  const blockedPath = evidence.locator('.workflow-evidence-row').filter({ hasText: 'Build and publish → Blocked outcome' })
  await expect(blockedPath).toContainText('Executed')
  await expect(blockedPath).not.toContainText('failed_gate')
  await expect(blockedPath).not.toContainText('quality-container-setup')
  await blockedPath.getByRole('button', { name: /Connection judgment/ }).click()
  const detailModal = page.getByTestId('workflow-evidence-detail-modal')
  await expect(detailModal.getByText('This connection was used', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('Only when the upstream node returns normally', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('Text to find', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('failed_gate', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('Failed step (value of failed_gate)', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('quality-container-setup', { exact: true })).toBeVisible()
  await expect(detailModal).not.toContainText('(taken)')
  await expect(detailModal).not.toContainText('(success)')
  await page.keyboard.press('Escape')
  await expect(detailModal).toBeHidden()

  await tabs.getByRole('tab', { name: 'Other judgments 3' }).click()
  const otherPaths = evidence.locator('.workflow-evidence-row')
  await expect(otherPaths).toHaveCount(3)
  const verifyPath = otherPaths.filter({ hasText: 'Build and publish → Verify release' })
  await expect(verifyPath).toContainText('Condition did not match')
  await expect(verifyPath).not.toContainText('HSR_RELEASED_OK')
  await verifyPath.getByRole('button', { name: /Connection judgment/ }).click()
  await expect(detailModal.getByText('HSR_RELEASED_OK', { exact: true })).toBeVisible()
  await expect(detailModal.getByText('Did not match', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  const runtimeFailurePath = otherPaths.filter({ hasText: 'Build and publish → Plain-language summary' })
  await expect(runtimeFailurePath).not.toContainText('fatal')
  await runtimeFailurePath.getByRole('button', { name: /Connection judgment/ }).click()
  await expect(detailModal.getByText('fatal', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(evidence).toContainText('The source node returned normally; this path is only used when node execution fails.')
  await expect(evidence).toContainText('The source node did not run, so this path was not part of this run.')

  const detailsScroller = page.getByTestId('workflow-run-details-page').locator('.workflow-runs-page-scroll')
  await expect(detailsScroller).toHaveCSS('overflow-y', 'auto')
  await expect(evidence.locator('.workflow-evidence-list')).toHaveCSS('overflow-y', 'visible')
  await expect(evidence.getByTestId('workflow-evidence-resize-handle')).toHaveCount(0)
})


test('workflow canvas animates the active route and preserves the completed route highlight', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const nodes = [
    { id: 'prepare', type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Prepare', agent: 'hermes', input: 'Prepare', skills: [], images: [], approvalRequired: false } },
    { id: 'publish', type: 'agent', position: { x: 420, y: 40 }, data: { title: 'Publish', agent: 'hermes', input: 'Publish', skills: [], images: [], approvalRequired: false } },
    { id: 'fallback', type: 'agent', position: { x: 420, y: 260 }, data: { title: 'Fallback', agent: 'hermes', input: 'Fallback', skills: [], images: [], approvalRequired: false } },
  ]
  const edges = [
    { id: 'prepare-publish', source: 'prepare', target: 'publish', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep' },
    { id: 'prepare-fallback', source: 'prepare', target: 'fallback', sourceHandle: 'output', targetHandle: 'input', type: 'smoothstep' },
  ]
  const edgeEvaluation = (runId: string, edgeId: string, targetNodeId: string, status: 'taken' | 'not_taken', sequence: number) => ({
    id: `${runId}-${edgeId}`, run_id: runId, workflow_id: 'wf-playback', edge_id: edgeId,
    source_node_id: 'prepare', source_execution_id: 'prepare', iteration_path: [], target_node_id: targetNodeId,
    source_outcome: 'success', status, route: 'success', reason: status === 'taken' ? null : 'condition_not_matched',
    sequence, orchestration: { route: 'success' }, condition_evaluation: null, evaluated_at: 2,
  })
  const run = (id: string, status: 'running' | 'completed', targetStatus: 'running' | 'completed') => ({
    id, workflow_id: 'wf-playback', profile: 'research', workspace: null, start_node_ids: ['prepare'], status,
    snapshot_nodes: nodes, snapshot_edges: edges, compiled_loops: [], started_at: 1, finished_at: status === 'completed' ? 2 : null, created_at: 1, error: null,
    node_sessions: [
      { id: `${id}-prepare`, run_id: id, workflow_id: 'wf-playback', node_id: 'prepare', execution_id: 'prepare', iteration_path: [], consumed_edge_evaluation_ids: [], session_id: `${id}-prepare-session`, profile: 'research', agent: 'hermes', agent_mode: '', status: 'completed', sequence: 1, started_at: 1, finished_at: 2, created_at: 1, updated_at: 2, error: null },
      { id: `${id}-publish`, run_id: id, workflow_id: 'wf-playback', node_id: 'publish', execution_id: 'publish', iteration_path: [], consumed_edge_evaluation_ids: [`${id}-prepare-publish`], session_id: `${id}-publish-session`, profile: 'research', agent: 'hermes', agent_mode: '', status: targetStatus, sequence: 2, started_at: 2, finished_at: targetStatus === 'completed' ? 3 : null, created_at: 2, updated_at: 3, error: null },
    ],
    edge_evaluations: [
      edgeEvaluation(id, 'prepare-publish', 'publish', 'taken', 3),
      edgeEvaluation(id, 'prepare-fallback', 'fallback', 'taken', 4),
    ],
    loop_epochs: [],
  })
  await mockHermesApi(page, {
    workflows: [{ id: 'wf-playback', name: 'Playback workflow', profile: 'research', workspace: null, nodes, edges, viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1 }],
    workflowRuns: [run('run-live', 'running', 'running'), run('run-completed', 'completed', 'completed')],
  })

  await page.goto('/#/hermes/workflow')
  const runs = page.locator('.workflow-run-item')
  await runs.nth(0).click()
  const selectedEdge = page.locator('.vue-flow__edge[data-id="prepare-publish"]')
  const unusedEdge = page.locator('.vue-flow__edge[data-id="prepare-fallback"]')
  await expect(selectedEdge).toHaveClass(/workflow-edge--flowing/)
  await expect(selectedEdge).toHaveClass(/animated/)
  await expect(unusedEdge).toHaveClass(/workflow-edge--inactive/)
  await expect(unusedEdge).not.toHaveClass(/workflow-edge--completed/)
  await expect(unusedEdge).not.toHaveClass(/animated/)

  await page.getByTestId('workflow-run-back').click()
  await runs.nth(1).click()
  await expect(selectedEdge).toHaveClass(/workflow-edge--completed/)
  await expect(selectedEdge).not.toHaveClass(/animated/)
  await expect(unusedEdge).toHaveClass(/workflow-edge--inactive/)
  await expect(unusedEdge).not.toHaveClass(/workflow-edge--completed/)
  await expect(unusedEdge).not.toHaveClass(/animated/)
})


test('workflow import reports an unsupported version without confirming or creating a workflow', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, {
    workflows: [],
    workflowImportPreviewError: 'unsupported workflow import version',
  })
  await page.goto('/#/hermes/workflow')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import Workflow' }).click()
  const fileChooser = await chooser
  await fileChooser.setFiles({
    name: 'future.workflow.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'hermes-studio.workflow', version: 2, definition: {} })),
  })
  await expect(page.getByText(/unsupported workflow import version/)).toBeVisible()
  expect(api.requests.filter(request => request.pathname === '/api/studio/workflows/import/confirm')).toHaveLength(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('workflow workspace stays available as a right-side icon when the title is hidden on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page, { workflows: [{
    id: 'wf-mobile', name: 'Mobile workflow title', profile: 'research', workspace: '/tmp/mobile-workspace',
    nodes: [], edges: [], viewport: null, created_at: 1, updated_at: 1,
  }] })
  await page.goto('/#/hermes/workflow')
  await expect(page.locator('.header-workflow-title')).toHaveText('Mobile workflow title')
  await expect(page.locator('.header-workflow-title')).toBeHidden()
  const workspaceButton = page.locator('.header-actions .header-workspace-button')
  await expect(workspaceButton).toBeInViewport()
  await expect(workspaceButton).toHaveText('')
  await expect(workspaceButton).toHaveAttribute('title', '/tmp/mobile-workspace')
  await expect(page.locator('.workspace-badge')).toHaveCount(0)
  await workspaceButton.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toHaveCSS('width', '358px')
  await expect(dialog.locator('.folder-picker')).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 844 })
  await expect(dialog).toHaveCSS('width', '520px')
  await expect(dialog.locator('.folder-picker').getByRole('textbox')).toHaveValue('/tmp/mobile-workspace')
})

test('workflow schedules can be created, edited, disabled, and deleted from the Workflow page', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page, {
    workflows: [{
      id: 'wf-schedule-ui', name: 'Scheduled workflow', profile: 'research', workspace: null,
      nodes: [{ id: 'agent-a', type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Agent A', agent: 'hermes', input: 'Run', skills: [], images: [], approvalRequired: false } }],
      edges: [], viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
    }],
  })

  await page.goto('/#/hermes/workflow')
  await page.getByRole('button', { name: 'Manage schedules' }).click()
  const modal = page.getByTestId('workflow-schedules-modal')
  await expect(modal).toBeVisible()
  await expect(modal.getByTestId('workflow-schedule-frequency')).toContainText('Select a frequency')
  await selectWorkflowScheduleFrequency(page, modal, 'Every week')
  await selectWorkflowScheduleField(page, modal, 'workflow-schedule-weekday', 'Wednesday')
  await selectWorkflowScheduleField(page, modal, 'workflow-schedule-hour', '08')
  await selectWorkflowScheduleField(page, modal, 'workflow-schedule-minute', '05')
  await modal.getByRole('textbox', { name: 'Timezone' }).fill('Asia/Shanghai')
  await modal.getByRole('button', { name: 'Create schedule' }).click()
  await expect(modal.getByText('5 8 * * 3', { exact: true })).toBeVisible()
  await modal.getByRole('button', { name: 'Edit schedule' }).click()
  await selectWorkflowScheduleFrequency(page, modal, 'Every month')
  await selectWorkflowScheduleField(page, modal, 'workflow-schedule-month-day', '5')
  await modal.getByRole('button', { name: 'Save schedule' }).click()
  await expect(modal.getByText('5 8 5 * *', { exact: true })).toBeVisible()
  await modal.getByRole('button', { name: 'Disable schedule' }).click()
  await expect(modal.getByText('Disabled', { exact: true })).toBeVisible()
  await modal.getByRole('button', { name: 'Delete schedule' }).click()
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(modal.getByText('No schedules yet', { exact: true })).toBeVisible()
})

test('workflow schedule form preserves disabled state and input whitespace after an inline toggle', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, {
    workflows: [{
      id: 'wf-schedule-edit', name: 'Scheduled workflow', profile: 'research', workspace: null,
      nodes: [{ id: 'agent-a', type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Agent A', agent: 'hermes', input: 'Run', skills: [], images: [], approvalRequired: false } }],
      edges: [], viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
    }],
    workflowSchedules: [{
      id: 'schedule-1', workflow_id: 'wf-schedule-edit', profile: 'research', schedule: '@daily', timezone: 'UTC', enabled: true,
      input: '  preserve me  ', start_node_ids: ['agent-a'], timeout_ms: null, concurrency_policy: 'skip', misfire_policy: 'skip',
      last_scheduled_at: null, next_run_at: null, last_run_id: null, last_error: null, created_at: 1, updated_at: 1,
    }],
  })

  await page.goto('/#/hermes/workflow')
  await page.getByRole('button', { name: 'Manage schedules' }).click()
  const modal = page.getByTestId('workflow-schedules-modal')
  await modal.getByRole('button', { name: 'Edit schedule' }).click()
  await modal.getByRole('button', { name: 'Disable schedule' }).click()
  await selectWorkflowScheduleFrequency(page, modal, 'Every hour')
  await modal.getByRole('button', { name: 'Save schedule' }).click()

  const saveRequest = api.requests.filter(request => request.method === 'PATCH' && request.pathname.endsWith('/schedules/schedule-1')).at(-1)
  expect(JSON.parse(saveRequest?.postData || '{}')).toMatchObject({ enabled: false, input: '  preserve me  ' })
})

test('workflow schedule start nodes only include the saved workflow definition', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page, {
    workflows: [{
      id: 'wf-schedule-nodes', name: 'Scheduled workflow', profile: 'research', workspace: null,
      nodes: [{ id: 'agent-a', type: 'agent', position: { x: 80, y: 80 }, data: { title: 'Agent A', agent: 'hermes', input: 'Run', skills: [], images: [], approvalRequired: false } }],
      edges: [], viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
    }],
  })

  await page.goto('/#/hermes/workflow')
  await page.getByRole('button', { name: 'Add Node' }).click()
  await expect(page.locator('.vue-flow__node')).toHaveCount(2)
  await page.getByRole('button', { name: 'Manage schedules' }).click()
  const modal = page.getByTestId('workflow-schedules-modal')
  await modal.getByTestId('workflow-schedule-start-nodes').click()
  await expect(page.getByText('Agent A', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Node 2', { exact: true })).toHaveCount(0)
})

test('workflow schedule loads do not overwrite the active workflow schedule list', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page, {
    workflowScheduleDelays: { 'wf-schedule-a': 500 },
    workflows: [
      { id: 'wf-schedule-a', name: 'Workflow A', profile: 'research', workspace: null, nodes: [], edges: [], viewport: null, created_at: 1, updated_at: 1 },
      { id: 'wf-schedule-b', name: 'Workflow B', profile: 'research', workspace: null, nodes: [], edges: [], viewport: null, created_at: 1, updated_at: 1 },
    ],
    workflowSchedules: [
      { id: 'schedule-a', workflow_id: 'wf-schedule-a', profile: 'research', schedule: '@daily', timezone: 'UTC', enabled: true, input: null, start_node_ids: [], timeout_ms: null, concurrency_policy: 'skip', misfire_policy: 'skip', last_scheduled_at: null, next_run_at: null, last_run_id: null, last_error: null, created_at: 1, updated_at: 1 },
      { id: 'schedule-b', workflow_id: 'wf-schedule-b', profile: 'research', schedule: '@hourly', timezone: 'UTC', enabled: true, input: null, start_node_ids: [], timeout_ms: null, concurrency_policy: 'skip', misfire_policy: 'skip', last_scheduled_at: null, next_run_at: null, last_run_id: null, last_error: null, created_at: 1, updated_at: 1 },
    ],
  })

  await page.goto('/#/hermes/workflow')
  await page.locator('.workflow-list-item').filter({ hasText: 'Workflow B' }).click()
  await page.getByRole('button', { name: 'Manage schedules' }).click()
  const modal = page.getByTestId('workflow-schedules-modal')
  await expect(modal.getByText('@hourly', { exact: true })).toBeVisible()
  await page.waitForTimeout(650)
  await expect(modal.getByText('@hourly', { exact: true })).toBeVisible()
  await expect(modal.getByText('@daily', { exact: true })).toHaveCount(0)
})

test('workflow schedule saves do not overwrite the active workflow schedule list', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, {
    workflowScheduleMutationDelays: { POST: 500 },
    workflows: [
      { id: 'wf-schedule-a', name: 'Workflow A', profile: 'research', workspace: null, nodes: [], edges: [], viewport: null, created_at: 1, updated_at: 1 },
      { id: 'wf-schedule-b', name: 'Workflow B', profile: 'research', workspace: null, nodes: [], edges: [], viewport: null, created_at: 1, updated_at: 1 },
    ],
    workflowSchedules: [
      { id: 'schedule-b', workflow_id: 'wf-schedule-b', profile: 'research', schedule: '@hourly', timezone: 'UTC', enabled: true, input: null, start_node_ids: [], timeout_ms: null, concurrency_policy: 'skip', misfire_policy: 'skip', last_scheduled_at: null, next_run_at: null, last_run_id: null, last_error: null, created_at: 1, updated_at: 1 },
    ],
  })

  await page.goto('/#/hermes/workflow')
  await page.getByRole('button', { name: 'Manage schedules' }).click()
  const modal = page.getByTestId('workflow-schedules-modal')
  await selectWorkflowScheduleFrequency(page, modal, 'Every week')
  await modal.getByRole('button', { name: 'Create schedule' }).click()
  await expect.poll(() => api.requests.filter(request => (
    request.method === 'POST' && request.pathname === '/api/studio/workflows/wf-schedule-a/schedules'
  )).length).toBe(1)

  await page.keyboard.press('Escape')
  await expect(modal).toBeHidden()
  await page.locator('.workflow-list-item').filter({ hasText: 'Workflow B' }).click()
  await page.getByRole('button', { name: 'Manage schedules' }).click()
  await expect(modal.getByText('@hourly', { exact: true })).toBeVisible()
  await page.waitForTimeout(650)
  await expect(modal.getByText('@hourly', { exact: true })).toBeVisible()
  await expect(modal.getByText('0 9 * * 1', { exact: true })).toHaveCount(0)
  expect(api.requests.filter(request => (
    request.pathname.startsWith('/api/studio/workflows/wf-schedule-b/schedules/')
    && request.method !== 'GET'
  ))).toEqual([])
})

test('workflow schedule saves cannot restore a schedule deleted while the save is pending', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, {
    workflowScheduleMutationDelays: { PATCH: 500 },
    workflows: [
      { id: 'wf-schedule-delete', name: 'Workflow delete', profile: 'research', workspace: null, nodes: [], edges: [], viewport: null, created_at: 1, updated_at: 1 },
    ],
    workflowSchedules: [
      { id: 'schedule-delete', workflow_id: 'wf-schedule-delete', profile: 'research', schedule: '@daily', timezone: 'UTC', enabled: true, input: null, start_node_ids: [], timeout_ms: null, concurrency_policy: 'skip', misfire_policy: 'skip', last_scheduled_at: null, next_run_at: null, last_run_id: null, last_error: null, created_at: 1, updated_at: 1 },
    ],
  })

  await page.goto('/#/hermes/workflow')
  await page.getByRole('button', { name: 'Manage schedules' }).click()
  const modal = page.getByTestId('workflow-schedules-modal')
  await modal.getByRole('button', { name: 'Edit schedule' }).click()
  await selectWorkflowScheduleFrequency(page, modal, 'Every hour')
  await modal.getByRole('button', { name: 'Save schedule' }).click()
  await expect.poll(() => api.requests.filter(request => (
    request.method === 'PATCH' && request.pathname === '/api/studio/workflows/wf-schedule-delete/schedules/schedule-delete'
  )).length).toBe(1)

  await modal.getByRole('button', { name: 'Delete schedule' }).click()
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect.poll(() => api.requests.filter(request => (
    request.method === 'DELETE' && request.pathname === '/api/studio/workflows/wf-schedule-delete/schedules/schedule-delete'
  )).length).toBe(1)
  await expect(modal.getByText('No schedules yet', { exact: true })).toBeVisible()
  await page.waitForTimeout(650)
  await expect(modal.getByText('No schedules yet', { exact: true })).toBeVisible()
  await expect(modal.getByText('0 * * * *', { exact: true })).toHaveCount(0)
})

test('workflow schedules show server errors without changing displayed schedule state', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page, {
    workflowScheduleError: 'Schedule service unavailable',
    workflows: [{ id: 'wf-schedule-error', name: 'Scheduled workflow', profile: 'research', workspace: null, nodes: [], edges: [], viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1 }],
  })

  await page.goto('/#/hermes/workflow')
  await page.getByRole('button', { name: 'Manage schedules' }).click()
  const modal = page.getByTestId('workflow-schedules-modal')
  await expect(modal).toBeVisible()
  await expect(modal.getByText('No schedules yet', { exact: true })).toHaveCount(0)
  await expect(modal.getByText(/Schedule service unavailable|Failed to load schedules/)).toBeVisible()
})

test('workflow schedule mutations keep unrelated saves and toggles synchronized', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, {
    workflowScheduleMutationDelays: { PATCH: 350 },
    workflows: [{ id: 'wf-schedule-concurrent', name: 'Concurrent workflow', profile: 'research', workspace: null, nodes: [], edges: [], viewport: null, created_at: 1, updated_at: 1 }],
    workflowSchedules: [
      { id: 'schedule-a', workflow_id: 'wf-schedule-concurrent', profile: 'research', schedule: '@daily', timezone: 'UTC', enabled: true, input: null, start_node_ids: [], timeout_ms: null, concurrency_policy: 'skip', misfire_policy: 'skip', last_scheduled_at: null, next_run_at: null, last_run_id: null, last_error: null, created_at: 1, updated_at: 1 },
      { id: 'schedule-b', workflow_id: 'wf-schedule-concurrent', profile: 'research', schedule: '@hourly', timezone: 'UTC', enabled: true, input: null, start_node_ids: [], timeout_ms: null, concurrency_policy: 'skip', misfire_policy: 'skip', last_scheduled_at: null, next_run_at: null, last_run_id: null, last_error: null, created_at: 1, updated_at: 1 },
    ],
  })

  await page.goto('/#/hermes/workflow')
  await page.getByRole('button', { name: 'Manage schedules' }).click()
  const modal = page.getByTestId('workflow-schedules-modal')
  const scheduleA = modal.locator('.workflow-schedule-item').filter({ hasText: '@daily' })
  const scheduleB = modal.locator('.workflow-schedule-item').filter({ hasText: '@hourly' })
  await scheduleA.getByRole('button', { name: 'Edit schedule' }).click()
  await selectWorkflowScheduleFrequency(page, modal, 'Every week')
  await modal.getByRole('button', { name: 'Save schedule' }).click()
  await expect.poll(() => api.requests.filter(request => request.method === 'PATCH' && request.pathname.endsWith('/schedules/schedule-a')).length).toBe(1)
  await scheduleB.getByRole('button', { name: 'Disable schedule' }).click()
  await expect.poll(() => api.requests.filter(request => request.method === 'PATCH' && request.pathname.endsWith('/schedules/schedule-b')).length).toBe(1)

  await expect(modal.getByRole('button', { name: 'Create schedule' })).toBeEnabled()
  await expect(modal.getByText('0 0 * * 1', { exact: true })).toBeVisible()
  await expect(scheduleB.getByText('Disabled', { exact: true })).toBeVisible()
})

test('workflow schedule mutations keep each concurrent toggle result', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, {
    workflowScheduleMutationDelays: { PATCH: 350 },
    workflows: [{ id: 'wf-schedule-toggles', name: 'Toggle workflow', profile: 'research', workspace: null, nodes: [], edges: [], viewport: null, created_at: 1, updated_at: 1 }],
    workflowSchedules: [
      { id: 'schedule-a', workflow_id: 'wf-schedule-toggles', profile: 'research', schedule: '@daily', timezone: 'UTC', enabled: true, input: null, start_node_ids: [], timeout_ms: null, concurrency_policy: 'skip', misfire_policy: 'skip', last_scheduled_at: null, next_run_at: null, last_run_id: null, last_error: null, created_at: 1, updated_at: 1 },
      { id: 'schedule-b', workflow_id: 'wf-schedule-toggles', profile: 'research', schedule: '@hourly', timezone: 'UTC', enabled: true, input: null, start_node_ids: [], timeout_ms: null, concurrency_policy: 'skip', misfire_policy: 'skip', last_scheduled_at: null, next_run_at: null, last_run_id: null, last_error: null, created_at: 1, updated_at: 1 },
    ],
  })

  await page.goto('/#/hermes/workflow')
  await page.getByRole('button', { name: 'Manage schedules' }).click()
  const modal = page.getByTestId('workflow-schedules-modal')
  const scheduleA = modal.locator('.workflow-schedule-item').filter({ hasText: '@daily' })
  const scheduleB = modal.locator('.workflow-schedule-item').filter({ hasText: '@hourly' })
  await scheduleA.getByRole('button', { name: 'Disable schedule' }).click()
  await expect.poll(() => api.requests.filter(request => request.method === 'PATCH' && request.pathname.endsWith('/schedules/schedule-a')).length).toBe(1)
  await scheduleB.getByRole('button', { name: 'Disable schedule' }).click()
  await expect.poll(() => api.requests.filter(request => request.method === 'PATCH' && request.pathname.endsWith('/schedules/schedule-b')).length).toBe(1)

  await expect(scheduleA.getByText('Disabled', { exact: true })).toBeVisible()
  await expect(scheduleB.getByText('Disabled', { exact: true })).toBeVisible()
})

test('a stale schedule list response cannot overwrite a successful create', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page, {
    workflowScheduleDelays: { 'wf-schedule-stale-list': 1_500 },
    workflowScheduleGetSnapshotAtRequest: true,
    workflows: [{ id: 'wf-schedule-stale-list', name: 'Stale list workflow', profile: 'research', workspace: null, nodes: [], edges: [], viewport: null, created_at: 1, updated_at: 1 }],
  })

  await page.goto('/#/hermes/workflow')
  await page.getByRole('button', { name: 'Manage schedules' }).click()
  const modal = page.getByTestId('workflow-schedules-modal')
  await selectWorkflowScheduleFrequency(page, modal, 'Every hour')
  await modal.getByRole('textbox', { name: 'Timezone' }).fill('UTC')
  await modal.getByRole('button', { name: 'Create schedule' }).click()
  await expect(modal.getByText('0 * * * *', { exact: true })).toBeVisible()
  await page.waitForTimeout(1_600)
  await expect(modal.getByText('0 * * * *', { exact: true })).toBeVisible()
})

test('a completed save does not reset a newer schedule editing draft', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, {
    workflowScheduleMutationDelays: { PATCH: 350 },
    workflows: [{ id: 'wf-schedule-draft', name: 'Draft workflow', profile: 'research', workspace: null, nodes: [], edges: [], viewport: null, created_at: 1, updated_at: 1 }],
    workflowSchedules: [
      { id: 'schedule-a', workflow_id: 'wf-schedule-draft', profile: 'research', schedule: '@daily', timezone: 'UTC', enabled: true, input: null, start_node_ids: [], timeout_ms: null, concurrency_policy: 'skip', misfire_policy: 'skip', last_scheduled_at: null, next_run_at: null, last_run_id: null, last_error: null, created_at: 1, updated_at: 1 },
      { id: 'schedule-b', workflow_id: 'wf-schedule-draft', profile: 'research', schedule: '@hourly', timezone: 'UTC', enabled: true, input: null, start_node_ids: [], timeout_ms: null, concurrency_policy: 'skip', misfire_policy: 'skip', last_scheduled_at: null, next_run_at: null, last_run_id: null, last_error: null, created_at: 1, updated_at: 1 },
    ],
  })

  await page.goto('/#/hermes/workflow')
  await page.getByRole('button', { name: 'Manage schedules' }).click()
  const modal = page.getByTestId('workflow-schedules-modal')
  const scheduleA = modal.locator('.workflow-schedule-item').filter({ hasText: '@daily' })
  const scheduleB = modal.locator('.workflow-schedule-item').filter({ hasText: '@hourly' })
  await scheduleA.getByRole('button', { name: 'Edit schedule' }).click()
  await selectWorkflowScheduleFrequency(page, modal, 'Every week')
  await modal.getByRole('button', { name: 'Save schedule' }).click()
  await expect.poll(() => api.requests.filter(request => request.method === 'PATCH' && request.pathname.endsWith('/schedules/schedule-a')).length).toBe(1)
  await scheduleB.getByRole('button', { name: 'Edit schedule' }).click()
  await selectWorkflowScheduleFrequency(page, modal, 'Every month')

  await page.waitForTimeout(450)
  await expect(modal.getByTestId('workflow-schedule-frequency')).toContainText('Every month')
  await expect(modal.getByRole('button', { name: 'Save schedule' })).toBeEnabled()
})

test('a pending schedule toggle disables that schedule until its request completes', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, {
    workflowScheduleMutationDelays: { PATCH: 350 },
    workflows: [{ id: 'wf-schedule-toggle-pending', name: 'Pending toggle workflow', profile: 'research', workspace: null, nodes: [], edges: [], viewport: null, created_at: 1, updated_at: 1 }],
    workflowSchedules: [
      { id: 'schedule-a', workflow_id: 'wf-schedule-toggle-pending', profile: 'research', schedule: '@daily', timezone: 'UTC', enabled: true, input: null, start_node_ids: [], timeout_ms: null, concurrency_policy: 'skip', misfire_policy: 'skip', last_scheduled_at: null, next_run_at: null, last_run_id: null, last_error: null, created_at: 1, updated_at: 1 },
    ],
  })

  await page.goto('/#/hermes/workflow')
  await page.getByRole('button', { name: 'Manage schedules' }).click()
  const modal = page.getByTestId('workflow-schedules-modal')
  const scheduleA = modal.locator('.workflow-schedule-item').filter({ hasText: '@daily' })
  const toggle = scheduleA.getByRole('button', { name: 'Disable schedule' })
  await toggle.click()
  await expect.poll(() => api.requests.filter(request => request.method === 'PATCH' && request.pathname.endsWith('/schedules/schedule-a')).length).toBe(1)
  await expect(toggle).toBeDisabled()
  await page.waitForTimeout(450)
  await expect(api.requests.filter(request => request.method === 'PATCH' && request.pathname.endsWith('/schedules/schedule-a'))).toHaveLength(1)
  await expect(scheduleA.getByText('Disabled', { exact: true })).toBeVisible()
})
