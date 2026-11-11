import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

async function example(page: Page, id: string, handle: (path: string, body: any) => unknown) {
  const directory = resolve('examples/plugins', id)
  const manifest = JSON.parse(await readFile(resolve(directory, 'plugin.json'), 'utf8'))
  const source = await readFile(resolve(directory, 'client.mjs'), 'utf8')
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const req = route.request(), path = new URL(req.url()).pathname
    const body = req.postData() ? req.postDataJSON() : {}
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (!path.startsWith('/api/studio/plugins')) return route.fulfill({ json: {} })
    if (path.endsWith('/client')) return route.fulfill({ json: { source } })
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'examples', events: [] } })
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: 1, plugins: [{ manifest, source: directory, config: {}, enabled: true, status: 'active', tools: [], commands: [], actions: [] }] } })
    return route.fulfill({ json: { result: handle(path, body) } })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__plugin_example__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_example__#/studio/plugins/' + id + '/' + manifest.views[0].id)
  return page.frameLocator('.plugin-workspace iframe')
}

test('session dashboard reads, filters, paginates and opens existing sessions', async ({ page }, testInfo) => {
  const requests: any[] = []
  const frame = await example(page, 'session-dashboard', (path, body) => {
    if (!path.endsWith('/api')) return {}
    requests.push(body)
    expect(body.path).toBe('/api/studio/sessions')
    const sessions = body.options.query.offset ? [{ id: 's3', title: '新页面会话', agent: 'codex', message_count: 5 }] : [
      { id: 's1', title: '插件设计讨论', agent: 'codex', message_count: 8, last_active: Date.now() / 1000 },
      { id: 's2', title: '<img src=x onerror=alert(1)>', agent: 'ekko-agent', message_count: 3, last_active: Date.now() / 1000 },
    ]
    return { sessions, total: 3, hasMore: !body.options.query.offset }
  })
  await expect(frame.locator('[data-total]')).toHaveText('3')
  await expect(frame.locator('[data-messages]')).toHaveText('11')
  await expect(frame.locator('.session')).toHaveCount(2)
  await expect(frame.locator('.session img')).toHaveCount(0)
  await frame.getByRole('combobox').selectOption('codex')
  await expect(frame.locator('.session')).toHaveCount(1)
  await frame.getByRole('searchbox').fill('不存在')
  await expect(frame.locator('.empty')).toContainText('没有匹配')
  await frame.getByRole('searchbox').fill('')
  await frame.getByRole('combobox').selectOption('')
  await frame.getByRole('button', { name: '加载更多会话' }).click()
  await expect(frame.locator('.session')).toHaveCount(3)
  expect(requests[1].options.query.offset).toBe(2)
  await expect(frame.locator('[data-messages]')).toHaveText('16')
  await page.locator('.plugin-workspace iframe').screenshot({ path: testInfo.outputPath('dashboard-light.png') })
  await frame.getByRole('button', { name: /插件设计讨论/ }).click()
  await expect.poll(() => page.evaluate(() => (window as any).pluginFixture.route())).toBe('/hermes/session/s1')
  await expect(page.locator('iframe')).toHaveCount(0)
  await page.evaluate(() => (window as any).pluginFixture.navigate('/studio/plugins/session-dashboard'))
  await page.evaluate(() => (window as any).pluginFixture.theme(true))
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(frame.getByRole('searchbox')).toBeVisible()
  expect(await frame.locator('body').evaluate(el => el.scrollWidth <= innerWidth)).toBe(true)
  await page.locator('.plugin-workspace iframe').screenshot({ path: testInfo.outputPath('dashboard-dark-mobile.png'), animations: 'disabled' })
})

test('notebook saves, completes, restores and deletes notes through its backend', async ({ page }, testInfo) => {
  let notes: any[] = []
  const frame = await example(page, 'notebook', (path, body) => {
    if (!path.endsWith('/invoke')) return {}
    if (body.name === 'get-preferences') return 'all'
    if (body.name === 'list') return notes
    if (body.name === 'append') { const note = { id: 'n1', text: body.input.text, origin: 'ui', done: false, createdAt: Date.now() }; notes.push(note); return note }
    if (body.name === 'update') { notes[0].done = body.input.done; return { ok: true } }
    if (body.name === 'remove') { notes = notes.filter(note => note.id !== body.input.id); return { ok: true } }
  })
  await expect(frame.locator('.empty')).toContainText('第一条想法')
  const save = frame.getByRole('button', { name: '添加便签' })
  await expect(save).toBeDisabled()
  await frame.getByRole('textbox', { name: '便签内容' }).fill('验证插件：刷新后依然保留')
  await save.click()
  await expect(frame.locator('.note-text')).toHaveText('验证插件：刷新后依然保留')
  await frame.getByRole('button', { name: '标记完成', exact: true }).click()
  await expect(frame.locator('[data-done]')).toHaveText('1')
  await page.reload()
  await expect(frame.getByRole('button', { name: '恢复待完成' })).toBeVisible()
  await page.locator('.plugin-workspace iframe').screenshot({ path: testInfo.outputPath('notebook-light.png') })
  await frame.getByRole('button', { name: '恢复待完成' }).click()
  await expect(frame.locator('[data-open]')).toHaveText('1')
  await frame.getByRole('button', { name: '已完成', exact: true }).click()
  await expect(frame.locator('.empty')).toContainText('这个分类')
  await frame.getByRole('button', { name: '全部', exact: true }).click()
  await page.evaluate(() => (window as any).pluginFixture.theme(true))
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await frame.locator('body').evaluate(el => el.scrollWidth <= innerWidth)).toBe(true)
  await page.locator('.plugin-workspace iframe').screenshot({ path: testInfo.outputPath('notebook-dark-mobile.png'), animations: 'disabled' })
  await frame.getByRole('button', { name: '删除便签' }).click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(frame.locator('.note')).toHaveCount(1)
  await frame.getByRole('button', { name: '删除便签' }).click()
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await expect(frame.locator('.empty')).toContainText('第一条想法')
  expect(notes).toHaveLength(0)
})
