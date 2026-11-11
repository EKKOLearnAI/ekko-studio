import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

test('manages a plugin and runs an isolated frontend through authenticated API and RPC', async ({ page }, testInfo) => {
  let revision = 0, installed = false, enabled = false, version = '1.0.0', previousVersion: string | undefined
  let config: Record<string, unknown> = { title: 'My notes' }
  const calls: any[] = [], stored = new Map<string, unknown>()
  let notified = false
  const plugin = () => ({ manifest: { id: 'notes', name: 'Notebook', version, apiVersion: 1, client: 'client.mjs', server: 'server.mjs', capabilities: ['ui', 'api.read', 'api.write', 'tools', 'storage.client'],
    views: [{ id: 'home', title: 'Notebook', slot: 'page' }], configSchema: { type: 'object', properties: { title: { type: 'string', title: 'Notebook title' }, token: { type: 'string', secret: true, title: 'Token' }, items: { type: 'array', title: 'Items', items: { type: 'string' } } } } },
    source: '/tmp/notes', installedAt: 0, enabled, status: enabled ? 'active' : 'disabled', previousVersion, config, tools: [], commands: [], actions: [] })
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const req = route.request(), url = new URL(req.url()), body = req.postData() ? req.postDataJSON() : {}
    if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (!url.pathname.startsWith('/api/studio/plugins')) return route.fulfill({ json: {} })
    calls.push({ path: url.pathname, method: req.method(), body, profile: req.headers()['x-hermes-profile'], token: req.headers().authorization })
    if (url.pathname.endsWith('/client')) return route.fulfill({ json: { source: `export async function mount(root,ctx){
      let isolated=false;try{parent.localStorage.getItem('hermes_api_key')}catch{isolated=true}
      const store=ctx.storage.namespace('projects').namespace('demo');
      await store.set('note', 'from browser'); const stored=await store.get('note'); const keys=await store.keys(); await store.delete('note'); const missing=await store.get('note');
      const data=await ctx.api.studio.sessions.list(); root.textContent='sessions='+data.sessions.length+' isolated='+isolated+' profile='+ctx.identity.profile+' storage='+stored+' keys='+keys.join(',')+' missing='+(missing===undefined);
      let eventCount=0;const onRun=()=>{eventCount++;root.dataset.runEvents=String(eventCount)};ctx.events.on('chat.*',onRun);ctx.events.on('chat.run.started',onRun);
      const controls=document.createElement('button');controls.textContent='Run SDK controls';controls.onclick=async()=>{await ctx.api.studio.sessions.create({title:'SDK'});await ctx.api.studio.sessions.run('s1','hello');await ctx.api.studio.sessions.stop('s1');await ctx.api.studio.groupChats.send('room','hello');await ctx.api.studio.groupChats.stop('room','Writer');await ctx.api.studio.workflows.stop('flow','run');root.dataset.controls='done'};root.append(controls);
      const button=document.createElement('button');button.textContent='Save note';button.onclick=async()=>{ const value=await ctx.rpc('save',{text:'hello'});root.append(document.createTextNode(' saved='+value)) };root.append(button);
      ctx.onDispose(()=>{root.textContent='disposed'})
    }` } })
    if (url.pathname.endsWith('/storage')) {
      expect(body.namespace).toEqual(['projects', 'demo'])
      const key = JSON.stringify([body.namespace, body.key])
      if (body.action === 'set') stored.set(key, body.value)
      if (body.action === 'delete') stored.delete(key)
      return route.fulfill({ json: body.action === 'keys' ? { keys: ['note'] } : { present: stored.has(key), value: stored.get(key) ?? null } })
    }
    if (url.pathname.endsWith('/api')) return route.fulfill({ json: { result: { sessions: [{ id: 's1' }] } } })
    if (url.pathname.endsWith('/invoke')) { notified = true; return route.fulfill({ json: { result: body.input.text } }) }
    if (url.pathname.endsWith('/events')) return route.fulfill({ json: { cursor: notified ? 1 : 0, generation: 'test', events: notified && Number(url.searchParams.get('cursor')) < 1 ? [{ id: 'notice', pluginId: 'notes', type: 'ui.notification', timestamp: Date.now(), identity: { userId: 1, profile: 'default' }, data: { message: 'Saved by backend', level: 'success' } }, { id: 'run-start', pluginId: 'notes', type: 'chat.run.started', timestamp: Date.now(), identity: { userId: 1, profile: 'default' }, data: {} }] : [] } })
    if (url.pathname.endsWith('/install')) { expect(body.trusted).toBe(true); expect(body.revision).toBe(revision); if (installed) { previousVersion = version; version = '2.0.0' } installed = true; revision++; return route.fulfill({ json: { ok: true } }) }
    if (req.method() === 'PATCH') {
      if (body.revision !== revision) return route.fulfill({ status: 409, json: { error: 'Plugin settings changed; reload before saving', code: 'PLUGIN_REVISION' } })
      expect(body.revision).toBe(revision)
      if (body.config) config = body.config
      if (body.enabled !== undefined) enabled = body.enabled
      if (body.action === 'rollback') [version, previousVersion] = [previousVersion!, version]
      if (body.action === 'uninstall') installed = false
      revision++; return route.fulfill({ json: { ok: true } })
    }
    return route.fulfill({ json: { revision, plugins: installed ? [plugin()] : [] } })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__studio_plugins__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__studio_plugins__')
  await expect(page.getByText('尚未安装 Studio 插件')).toBeVisible()
  await page.getByRole('button', { name: '安装插件', exact: true }).click()
  const install = page.getByRole('button', { name: '安装', exact: true })
  await expect(install).toBeDisabled()
  await page.getByRole('textbox', { name: '绝对目录、package@version 或 github:owner/repo#commit' }).fill('/tmp/notes')
  await page.getByRole('checkbox').check(); await install.click()
  await page.getByRole('button', { name: '启用', exact: true }).click()
  await expect(page.locator('.plugin-card')).toHaveCount(1)
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Notebook', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '打开', exact: true }).click()
  const frame = page.frameLocator('iframe')
  await expect(frame.locator('#root')).toContainText('sessions=1 isolated=true profile=default storage=from browser keys=note missing=true')
  await frame.getByRole('button', { name: 'Save note' }).click()
  await expect(frame.locator('#root')).toContainText('saved=hello')
  await expect(frame.locator('#root')).toHaveAttribute('data-run-events', '1')
  await frame.getByRole('button', { name: 'Run SDK controls' }).click()
  await expect(frame.locator('#root')).toHaveAttribute('data-controls', 'done')
  expect(calls.filter(c => c.path.endsWith('/api')).map(c => c.body.path)).toEqual(expect.arrayContaining(['/api/studio/sessions/s1/stop', '/api/studio/group-chat/rooms/room/messages', '/api/studio/group-chat/rooms/room/stop', '/api/studio/workflows/flow/runs/run/stop']))
  await expect(page.getByText('notes: Saved by backend', { exact: true })).toBeVisible()
  expect(calls.find(c => c.path.endsWith('/api'))).toMatchObject({ profile: 'default', body: { path: '/api/studio/sessions' }, token: expect.stringMatching(/^Bearer /) })
  await expect(page.locator('.plugin-workspace')).toBeVisible()
  await page.getByRole('button', { name: '管理插件' }).click()
  await expect(page.locator('iframe')).toHaveCount(0)
  const lightText = await page.locator('.center-intro h1').evaluate(element => getComputedStyle(element).color)
  await page.screenshot({ path: testInfo.outputPath('plugins-light.png'), fullPage: true })
  await page.locator('.n-tabs-tab').getByText('配置', { exact: true }).click()
  await page.getByRole('textbox', { name: 'Items', exact: true }).fill('[invalid')
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await page.getByRole('textbox', { name: 'Items', exact: true }).fill('["note"]')
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  expect(calls.find(c => c.body.config)?.body.config.items).toEqual(['note'])
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
  await page.getByRole('textbox', { name: 'Notebook title', exact: true }).fill('unsaved draft')
  config = { ...config, title: 'changed by another administrator' }; revision++
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/studio/plugins')
  await page.evaluate(() => (window as any).pluginFixture.changed())
  await refreshed
  await expect(page.getByRole('textbox', { name: 'Notebook title', exact: true })).toHaveValue('unsaved draft')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('dialog').getByText(/Plugin settings changed/)).toBeVisible()
  expect(config.title).toBe('changed by another administrator')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.getByRole('button', { name: '详情', exact: true }).click()
  await page.locator('.n-tabs-tab').getByText('配置', { exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Notebook title', exact: true })).toHaveValue('changed by another administrator')
  await page.locator('.n-tabs-tab').getByText('开发与维护', { exact: true }).click()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: '升级', exact: true }).click()
  await expect(page.locator('.plugin-card .version')).toHaveText('v2.0.0')
  await page.getByRole('button', { name: '回滚 1.0.0' }).click()
  await expect(page.locator('.plugin-card .version')).toHaveText('v1.0.0')
  await page.evaluate(() => (window as any).pluginFixture.theme(true))
  await expect.poll(() => page.locator('.center-intro h1').evaluate(element => getComputedStyle(element).color)).not.toBe(lightText)
  await page.screenshot({ path: testInfo.outputPath('plugins-dark-wallpaper.png'), fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: '禁用', exact: true }).click()
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.locator('.studio-navigation-rail__plugins a')).toHaveCount(0)
  await page.getByRole('button', { name: '卸载', exact: true }).click()
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await expect(page.getByText('尚未安装 Studio 插件')).toBeVisible()
})
