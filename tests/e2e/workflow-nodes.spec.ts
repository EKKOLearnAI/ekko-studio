import { test, expect, type Locator, type Page } from '@playwright/test'
import { resolve } from 'node:path'

const node = (page: Page, id: number) => page.locator(`.vue-flow__node[data-id="agent-${id}"]`)

async function openWorkflow(page: Page, { empty = false, protocolMismatch = false, switchable = false, withRun = false } = {}) {
  const saves: any[] = [], errors: string[] = []
  const workflow = {
    id: 'workflow-fixture', name: '节点编辑验证', profile: 'default', workspace: null,
    nodes: empty ? [] : [{
      id: 'agent-1', type: 'agent', position: { x: 340, y: 20 },
      data: { title: '已有节点', agent: 'ekko-agent', agentMode: 'scoped', provider: 'fixture',
        model: 'fixture-model', apiMode: 'chat_completions', reasoningEffort: 'low',
        input: 'fixture input', skills: [], images: [], approvalRequired: false, orchestration: { join: 'all' } },
    }],
    edges: [], viewport: { x: 80, y: 80, zoom: 0.75 }, created_at: 1, updated_at: 1,
  }
  const other = { ...workflow, id: 'other-workflow', name: '另一个工作流', nodes: [], updated_at: 0 }
  const run = { id: 'run-fixture', workflow_id: workflow.id, profile: 'default', status: 'completed',
    created_at: 1, started_at: 1, completed_at: 2, start_node_ids: [], node_sessions: [],
    snapshot_nodes: workflow.nodes.map(item => ({ ...item, data: { ...item.data, title: '执行快照标题' } })), snapshot_edges: [],
  }
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.addInitScript(() => {
    localStorage.setItem('hermes_locale', 'zh')
    localStorage.setItem('hermes_api_key', 'synthetic-isolation-key')
    ;(window as any).__APP_VERSION__ = 'test'
  })
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route('**/src/api/studio/workflow-socket.ts*', route => route.fulfill({
    contentType: 'text/javascript', body: `
      export const onWorkflowStatusUpdated = () => () => {};
      export const onWorkflowStatusError = () => () => {};
      export const subscribeWorkflowStatuses = async () => [];
      export const listWorkflowsSocket = async () => [];
    `,
  }))
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const { pathname } = new URL(route.request().url())
    let json: any = {}
    if (pathname === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: 'super_admin' } }
    else if (pathname === '/api/auth/avatar') json = { avatar: null }
    else if (pathname === '/api/hermes/profiles') json = { profiles: [{ name: 'default', alias: 'Default', active: true, model: 'fixture-model' }] }
    else if (pathname === '/api/hermes/available-models') json = {
      groups: [{ provider: 'fixture', label: 'Fixture', base_url: 'http://fixture.invalid', api_key: '',
        api_mode: 'chat_completions', models: ['fixture-model'],
        ...(protocolMismatch ? { api_mode_by_model: { 'fixture-model': 'codex_responses' }, model_meta: { 'fixture-model': { reasoning: false } } } : {}),
      }], profiles: [], allProviders: [], default: 'fixture-model', default_provider: 'fixture',
    }
    else if (pathname === '/api/agents/availability') json = { revision: 1, updatedAt: '2026-11-03',
      agents: ['ekko-agent', 'hermes', 'codex'].map(id => ({ id, available: true, installed: true, source: 'built-in' })),
    }
    else if (pathname === '/api/studio/workflows') json = { workflows: switchable ? [workflow, other] : [workflow] }
    else if (pathname === '/api/studio/workflows/workflow-fixture' && route.request().method() === 'PATCH') {
      const input = route.request().postDataJSON()
      saves.push(input)
      json = { ...workflow, ...input }
    }
    else if (pathname === '/api/studio/workflows/workflow-fixture/runs') json = { runs: withRun ? [run] : [] }
    else if (pathname.endsWith('/runs/run-fixture')) json = run
    else if (pathname.endsWith('/runs')) json = { runs: [] }
    else if (pathname.endsWith('/schedules')) json = { schedules: [] }
    else if (pathname.includes('/skills')) {
      // Exercise the asynchronous skill-options refresh as well as field updates.
      await new Promise(done => setTimeout(done, 50))
      json = { categories: [], archived: [] }
    }
    else if (pathname.startsWith('/api/studio/sessions')) json = { sessions: [] }
    else if (pathname.includes('/models')) json = { agents: [] }
    await route.fulfill({ json })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/workflow-nodes.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__workflow_nodes__', route => route.fulfill({ contentType: 'text/html',
    body: `<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>`,
  }))
  await page.goto('/__workflow_nodes__')
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
  if (!empty) await expect(node(page, 1)).toBeVisible()
  return { saves, errors }
}

async function addNode(page: Page, id: number) {
  await page.getByRole('button', { name: '添加节点', exact: true }).click()
  await expect(node(page, id)).toBeVisible()
  return node(page, id)
}

async function selectAgent(page: Page, target: Locator, label: string) {
  await target.locator('.n-select').first().click()
  await page.locator('.n-base-select-option').filter({ hasText: new RegExp(`^${label}$`) }).click()
}

async function connectNodes(page: Page) {
  await node(page, 1).locator('.output-handle').dragTo(node(page, 2).locator('.input-handle'))
  await expect(page.locator('.vue-flow__edge')).toHaveCount(1)
}

test('keeps a new node visible after selecting another Agent and saves its selection', async ({ page }) => {
  const { saves, errors } = await openWorkflow(page)
  const added = await addNode(page, 2)
  await selectAgent(page, added, 'Hermes')
  await expect(added).toBeVisible()
  await expect(added.locator('.n-select').first()).toContainText('Hermes')
  await expect(node(page, 1)).toBeVisible()
  await added.locator('.node-prompt-input textarea').fill('new node input')
  await connectNodes(page)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(() => saves.length).toBe(1)
  expect(saves[0].nodes).toHaveLength(2)
  expect(saves[0].nodes[1].data).toMatchObject({ agent: 'hermes', reasoningEffort: 'low' })
  expect(errors).toEqual([])
})

test('keeps a new node visible when editing its title', async ({ page }) => {
  const { errors } = await openWorkflow(page)
  const added = await addNode(page, 2)
  await added.locator('.n-input input').first().fill('修改后的标题')
  await expect(added).toBeVisible()
  await expect(added.locator('.n-input input').first()).toHaveValue('修改后的标题')
  await expect(node(page, 1).locator('.n-input input').first()).toHaveValue('已有节点')
  expect(errors).toEqual([])
})

test('measures the first and successive nodes after automatic reasoning normalization', async ({ page }) => {
  const { errors } = await openWorkflow(page, { empty: true })
  for (const id of [1, 2, 3]) {
    await addNode(page, id)
    for (let previous = 1; previous <= id; previous++) await expect(node(page, previous)).toBeVisible()
  }
  await expect(page.locator('.vue-flow__node')).toHaveCount(3)
  expect(errors).toEqual([])
})

test('keeps a new node visible after automatic per-model protocol normalization', async ({ page }) => {
  const { saves, errors } = await openWorkflow(page, { empty: true, protocolMismatch: true })
  const added = await addNode(page, 1)
  await added.locator('.node-prompt-input textarea').fill('protocol fixture')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(() => saves.length).toBe(1)
  expect(saves[0].nodes[0].data.apiMode).toBe('codex_responses')
  await expect(added).toBeVisible()
  expect(errors).toEqual([])
})

test('preserves measured size and position through Agent edits, dragging, resizing and saving', async ({ page }) => {
  const { saves, errors } = await openWorkflow(page)
  const added = await addNode(page, 2)
  await selectAgent(page, added, 'Codex')
  await expect(added).toBeVisible()
  const before = (await added.boundingBox())!
  const header = (await added.locator('.node-header').boundingBox())!
  await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2)
  await page.mouse.down()
  await page.mouse.move(header.x + header.width / 2 + 100, header.y + header.height / 2 + 60, { steps: 12 })
  await page.mouse.up()
  const moved = (await added.boundingBox())!
  expect(moved.x - before.x).toBeGreaterThan(80)
  expect(moved.y - before.y).toBeGreaterThan(40)
  const handle = added.locator('.workflow-resize-handle.bottom.right')
  await expect(handle).toBeVisible()
  const corner = (await handle.boundingBox())!
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2)
  await page.mouse.down()
  await page.mouse.move(corner.x + corner.width / 2 + 60, corner.y + corner.height / 2 + 40, { steps: 12 })
  await page.mouse.up()
  const resized = (await added.boundingBox())!
  expect(resized.width).toBeGreaterThan(moved.width + 50)
  expect(resized.height).toBeGreaterThan(moved.height + 30)
  await added.locator('.n-input input').first().fill('移动并缩放后的节点')
  await added.locator('.node-prompt-input textarea').fill('geometry fixture')
  await connectNodes(page)
  await expect(added).toBeVisible()
  const geometry = await added.evaluate(el => {
    const element = el as HTMLElement, matrix = new DOMMatrix(element.style.transform)
    return { position: { x: matrix.m41, y: matrix.m42 }, style: { width: element.style.width, height: element.style.height } }
  })
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(() => saves.length).toBe(1)
  const saved = saves[0].nodes.find((item: any) => item.id === 'agent-2')
  expect(saved.position.x).toBeCloseTo(geometry.position.x, 3)
  expect(saved.position.y).toBeCloseTo(geometry.position.y, 3)
  expect(saved.style).toEqual(geometry.style)
  expect(saved.data).toMatchObject({ agent: 'codex', title: '移动并缩放后的节点' })
  expect(saved).not.toHaveProperty('dimensions')
  expect(errors).toEqual([])
})

test('restores edited nodes when switching workflows and remounting the canvas', async ({ page }) => {
  const { errors } = await openWorkflow(page, { switchable: true })
  const added = await addNode(page, 2)
  await added.locator('.n-input input').first().fill('切换后保留的标题')
  await selectAgent(page, added, 'Hermes')
  await page.getByRole('button', { name: /^另一个工作流 default/ }).click()
  await expect(page.locator('.vue-flow__node')).toHaveCount(0)
  await page.getByRole('button', { name: /^节点编辑验证 default/ }).click()
  await expect(node(page, 1)).toBeVisible()
  await expect(node(page, 2)).toBeVisible()
  await expect(node(page, 2).locator('.n-input input').first()).toHaveValue('切换后保留的标题')
  await expect(node(page, 2).locator('.n-select').first()).toContainText('Hermes')
  expect(errors).toEqual([])
})

test('renders run snapshot nodes as readonly and restores the editable definition', async ({ page }) => {
  const { errors } = await openWorkflow(page, { withRun: true })
  await page.locator('.workflow-run-item').click()
  await expect(node(page, 1)).toBeVisible()
  await expect(node(page, 1).locator('.n-input input').first()).toHaveValue('执行快照标题')
  await expect(node(page, 1).locator('.n-input input').first()).toBeDisabled()
  await page.getByRole('button', { name: '隐藏执行记录', exact: true }).click()
  await expect(node(page, 1)).toBeVisible()
  await expect(node(page, 1).locator('.n-input input').first()).toHaveValue('已有节点')
  await expect(node(page, 1).locator('.n-input input').first()).toBeEnabled()
  expect(errors).toEqual([])
})

test('keeps a node created from a connection visible and undoes the canvas transaction', async ({ page }) => {
  const { errors } = await openWorkflow(page)
  const source = (await node(page, 1).locator('.output-handle').boundingBox())!
  const canvas = (await page.locator('.workflow-flow').boundingBox())!
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(canvas.x + canvas.width * 0.67, canvas.y + canvas.height * 0.15, { steps: 12 })
  await page.mouse.up()
  await expect(node(page, 2)).toBeVisible()
  await expect(page.locator('.vue-flow__edge')).toHaveCount(1)
  await node(page, 2).locator('.n-input input').first().fill('连线创建的节点')
  await expect(node(page, 2)).toBeVisible()
  await page.locator('.vue-flow__pane').click({ position: { x: 20, y: 20 } })
  await page.keyboard.press('Control+z')
  await expect(node(page, 2)).toHaveCount(0)
  await expect(page.locator('.vue-flow__edge')).toHaveCount(0)
  await expect(node(page, 1)).toBeVisible()
  expect(errors).toEqual([])
})
