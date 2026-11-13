import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test('bridges a plugin CDP call through the host, reports unavailable Desktop and allows retry', async ({ page }) => {
  const calls: any[] = [], errors: string[] = []
  let available = false
  page.on('pageerror', error => errors.push(error.message))
  const manifest = { id: 'cdp', name: 'CDP demo', version: '2.0.0', apiVersion: 1, permissions: ['ui', 'browser.cdp'], client: 'client.mjs', views: [{ id: 'home', title: 'Browser', slot: 'page' }] }
  const source = `export function mount(root,ctx){
    const button=document.createElement('button');button.textContent='Read browser title';
    const output=document.createElement('output');
    button.onclick=async()=>{try{
      const {tabs}=await ctx.host.browser.tabs.list();
      const attached=await ctx.host.browser.cdp.attach(tabs[0].id);
      try{const result=await ctx.host.browser.cdp.send(tabs[0].id,'Runtime.evaluate',{expression:'document.title',returnByValue:true});output.textContent=result.result.value}
      finally{await ctx.host.browser.cdp.release(tabs[0].id)}
    }catch(error){output.textContent=error.message}};
    root.dataset.cleanups='0';
    const release=ctx.lifecycle.add(()=>{root.dataset.cleanups=String(Number(root.dataset.cleanups)+1)});
    const cleanup=document.createElement('button');cleanup.textContent='Release twice';cleanup.onclick=async()=>{await release();await release()};
    root.append(button,cleanup,output);
  }`
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: 1, plugins: [{ manifest, status: 'active', enabled: true, config: {}, tools: [], commands: [], actions: [] }] } })
    if (path.endsWith('/client')) return route.fulfill({ json: { source } })
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'cdp', events: [] } })
    if (path.endsWith('/browser')) {
      const input = route.request().postDataJSON(); calls.push({ ...input, profile: url.searchParams.get('profile') })
      if (!available) return route.fulfill({ status: 409, json: { error: 'No authorized active Desktop browser' } })
      const values: Record<string, unknown> = { 'tabs.list': { tabs: [{ id: 'tab' }] }, 'cdp.attach': { cursor: 0, sessions: [] }, 'cdp.send': { result: { value: 'Existing desktop login' } }, 'lease.release': { ok: true } }
      return route.fulfill({ json: values[input.method] })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replace(/^\//, '')
  await page.route('**/__plugin_cdp__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_cdp__#/studio/plugins/cdp/home')
  const frame = page.frameLocator('.plugin-workspace iframe')
  await frame.getByRole('button', { name: 'Read browser title' }).click()
  await expect(frame.locator('output')).toContainText('No authorized active Desktop browser')
  available = true
  await frame.getByRole('button', { name: 'Read browser title' }).click()
  await expect(frame.locator('output')).toHaveText('Existing desktop login')
  expect(calls.map(call => call.method)).toEqual(['tabs.list', 'tabs.list', 'cdp.attach', 'cdp.send', 'lease.release'])
  expect(calls[3]).toMatchObject({ profile: 'default', params: { tab_id: 'tab', method: 'Runtime.evaluate', params: { expression: 'document.title', returnByValue: true } } })
  await frame.getByRole('button', { name: 'Release twice' }).click()
  await expect(frame.locator('#root')).toHaveAttribute('data-cleanups', '1')
  expect(errors).toEqual([])
})
