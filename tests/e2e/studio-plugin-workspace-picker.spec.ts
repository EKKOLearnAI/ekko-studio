import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

async function setup(page: Page) {
  const errors: string[] = [], saved: unknown[] = [], history: string[] = [], writes: string[] = []
  const state = { shortcutsFail: false, emptyFolders: false, favorites: ['/work/favorite'] }
  page.on('pageerror', error => errors.push(error.message))
  const manifest = { id: 'workspace-picker', name: 'Workspace demo', version: '1.0.0', apiVersion: 1, permissions: ['ui'], client: 'client.mjs',
    views: [{ id: 'home', title: 'Workspace picker', slot: 'page' }] }
  const source = `export function mount(root,ctx){
    let current='/work/old';
    const output=document.createElement('output');output.id='result';
    const choose=document.createElement('button');choose.textContent='Choose workspace';choose.onclick=async()=>{
      output.textContent='pending';
      try{const result=await ctx.ui.selectWorkspace({current});output.textContent=JSON.stringify(result);if(result){current=result.workspace;await ctx.rpc.call('save-workspace',result)}}
      catch(error){output.textContent='error: '+error.message}
    };
    const twice=document.createElement('button');twice.textContent='Choose twice';twice.onclick=async()=>{
      output.textContent='pending';const results=await Promise.allSettled([ctx.ui.selectWorkspace(),ctx.ui.selectWorkspace()]);
      output.textContent=JSON.stringify(results.map(result=>result.status==='fulfilled'?{value:result.value}:{error:result.reason.message}));
    };
    root.append(choose,twice,output);
  }`
  const directories = () => [...new Set([...state.favorites, '/work/recent', ...history])].map(path => ({
    path, isFavorite: state.favorites.includes(path), lastUsed: path === '/work/recent' || history.includes(path) ? 10 : 0, useCount: 1, createdAt: 1, updatedAt: 1,
  }))
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname
    if (request.method() !== 'GET') writes.push(path)
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: 1, plugins: [{ manifest, status: 'active', enabled: true, config: {}, tools: [], commands: [], actions: [] }] } })
    if (path.endsWith('/client')) return route.fulfill({ json: { source } })
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'workspace-picker', events: [] } })
    if (path.endsWith('/invoke')) { saved.push(request.postDataJSON().input); return route.fulfill({ json: { result: { ok: true } } }) }
    if (path === '/api/studio/workspace/directories') {
      if (request.method() === 'GET' && state.shortcutsFail) return route.fulfill({ status: 503, json: { error: 'Shortcut storage unavailable' } })
      if (request.method() === 'POST') history.push(request.postDataJSON().path)
      if (request.method() === 'PATCH') {
        const { path, favorite } = request.postDataJSON()
        state.favorites = state.favorites.filter(value => value !== path)
        if (favorite) state.favorites.push(path)
      }
      return route.fulfill({ json: { directories: directories() } })
    }
    if (path === '/api/studio/workspace/folders') {
      const nested = url.searchParams.get('path') === 'projects'
      return route.fulfill({ json: { base: '/work', current: nested ? 'projects' : '', folders: state.emptyFolders ? [] : nested
        ? [{ name: 'Nested', path: 'projects/nested', fullPath: '/work/projects/nested' }]
        : [{ name: 'Projects', path: 'projects', fullPath: '/work/projects' }] } })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replaceAll('\\', '/').replace(/^\//, '')
  // These mocked HTML pages bypass Vite's normal index transform and need its define globals.
  await page.route('**/__plugin_workspace_picker__', route => route.fulfill({ contentType: 'text/html',
    body: `<div id="app"></div><script type="module" src="/@vite/env"></script><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_workspace_picker__#/studio/plugins/workspace-picker/home')
  const frame = page.frameLocator('.plugin-workspace iframe'), modal = page.locator('.workspace-picker-modal')
  await expect(frame.getByRole('button', { name: 'Choose workspace', exact: true })).toBeVisible()
  return { frame, modal, state, history, saved, writes, errors }
}

test('returns a host-selected directory, supports account shortcuts, and leaves session binding to the plugin', async ({ page }, testInfo) => {
  const { frame, modal, history, saved, writes, errors } = await setup(page)
  const choose = frame.getByRole('button', { name: 'Choose workspace', exact: true })
  await choose.click()
  await expect(modal).toHaveAttribute('aria-label', 'Workspace demo · 选择工作区')
  const input = modal.getByRole('textbox')
  await expect(input).toHaveValue('/work/old')
  await expect(modal.getByRole('group', { name: '收藏的工作区' }).getByRole('button', { name: 'favorite', exact: true })).toBeVisible()
  await modal.getByRole('group', { name: '最近使用' }).getByRole('button', { name: 'recent', exact: true }).click()
  await expect(input).toHaveValue('/work/recent')
  await modal.getByRole('button', { name: '展开: Projects', exact: true }).click()
  await modal.getByRole('button', { name: 'Nested', exact: true }).click()
  await expect(input).toHaveValue('/work/projects/nested')
  await page.screenshot({ path: testInfo.outputPath('workspace-picker-light.png'), animations: 'disabled' })
  await modal.getByRole('button', { name: '确定', exact: true }).click()
  const selection = { profile: 'default', workspace: '/work/projects/nested' }
  await expect(frame.locator('#result')).toHaveText(JSON.stringify(selection))
  await expect.poll(() => saved).toEqual([selection])
  await expect.poll(() => history).toEqual(['/work/projects/nested'])

  await page.evaluate(() => {
    const fixture = (window as any).pluginFixture
    fixture.appearance({ brightness: 'dark', appearance: { global: { opacity: .7 }, regions: { card: { opacity: 0, blur: 0, radius: 12 }, overlay: { opacity: .4, blur: 0, radius: 16 } } } })
    fixture.wallpaper(true)
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await choose.click()
  await expect(modal).toBeVisible()
  await expect(modal.getByRole('textbox')).toHaveValue(selection.workspace)
  await expect(modal).toHaveCSS('border-radius', '16px')
  await expect(modal).toHaveCSS('backdrop-filter', 'none')
  expect(await modal.evaluate(element => element.getBoundingClientRect().width <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('workspace-picker-dark-mobile.png'), animations: 'disabled' })
  await modal.getByRole('textbox').fill('/work/not-confirmed')
  await modal.getByRole('button', { name: '取消', exact: true }).click()
  await expect(frame.locator('#result')).toHaveText('null')
  expect(saved).toHaveLength(1)
  expect(history).toEqual([selection.workspace])
  expect(writes.every(path => path === '/api/studio/workspace/directories' || path.endsWith('/invoke'))).toBe(true)
  expect(errors).toEqual([])
})

test('rejects overlapping calls and cancels pickers on Profile changes and navigation', async ({ page }) => {
  const { frame, modal, history, errors } = await setup(page)
  await frame.getByRole('button', { name: 'Choose twice', exact: true }).click()
  await expect(modal.getByRole('button', { name: '确定', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(frame.locator('#result')).toHaveText(JSON.stringify([{ value: null }, { error: 'A workspace picker is already open for this plugin view' }]))
  await frame.getByRole('button', { name: 'Choose workspace', exact: true }).click()
  await expect(modal).toBeVisible()
  await page.evaluate(() => (window as any).pluginFixture.profile('team'))
  await expect(modal).toHaveCount(0)
  await frame.getByRole('button', { name: 'Choose workspace', exact: true }).click()
  await modal.getByRole('group', { name: '收藏的工作区' }).getByRole('button', { name: 'favorite', exact: true }).click()
  await modal.getByRole('button', { name: '确定', exact: true }).click()
  await expect(frame.locator('#result')).toHaveText(JSON.stringify({ profile: 'team', workspace: '/work/favorite' }))
  await frame.getByRole('button', { name: 'Choose workspace', exact: true }).click()
  await expect(modal).toBeVisible()
  await page.evaluate(() => (window as any).pluginFixture.navigate('/studio/plugins'))
  await expect(modal).toHaveCount(0)
  expect(history).toEqual(['/work/favorite'])
  expect(errors).toEqual([])
})

test('retries shortcuts, handles an empty folder tree, and saves explicit favorites independently of confirmation', async ({ page }) => {
  const { frame, modal, state, history, saved, errors } = await setup(page)
  state.shortcutsFail = true; state.emptyFolders = true
  await frame.getByRole('button', { name: 'Choose workspace', exact: true }).click()
  await expect(modal.getByRole('alert')).toContainText('设置工作区失败')
  await expect(modal.getByText('暂无工作区文件夹')).toBeVisible()
  state.shortcutsFail = false
  await modal.getByRole('button', { name: '重试', exact: true }).click()
  await expect(modal.getByRole('alert')).toHaveCount(0)
  await modal.getByRole('textbox').fill('   ')
  await expect(modal.getByRole('button', { name: '确定', exact: true })).toBeDisabled()
  await modal.getByRole('textbox').fill('/work/manual')
  await modal.getByRole('button', { name: '收藏工作区', exact: true }).click()
  await expect.poll(() => state.favorites).toContain('/work/manual')
  await expect(modal.getByRole('button', { name: '取消收藏', exact: true })).toBeVisible()
  await modal.getByRole('button', { name: '取消', exact: true }).click()
  await expect(frame.locator('#result')).toHaveText('null')
  expect(history).toEqual([])
  expect(saved).toEqual([])
  expect(errors).toEqual([])
})
