import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test('delivers core chat and BOT streams into a plugin iframe and releases its own subscriptions', async ({ page }) => {
  const commands: any[] = [], errors: string[] = []
  let disconnected = false
  page.on('pageerror', error => errors.push(error.message))
  await page.routeWebSocket('**/socket.io/**', ws => {
    ws.send('0' + JSON.stringify({ sid: 'engine', upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 }))
    ws.onMessage(message => {
      const text = String(message)
      if (text.startsWith('40/plugins,')) { ws.send('40/plugins,' + JSON.stringify({ sid: 'plugins' })); return }
      if (text.startsWith('41/plugins')) { disconnected = true; return }
      const match = /^42\/plugins,(\d+)(\[.*)$/.exec(text)
      if (!match) return
      const [event, input] = JSON.parse(match[2]); commands.push({ event, input })
      const send = (value: object) => ws.send('42/plugins,' + JSON.stringify(['session.event', { id: input.id, event: value }]))
      ws.send(`43/plugins,${match[1]}[{"ok":true}]`)
      if (event === 'session.open') send({ event: 'resumed', session_id: input.sessionId, messages: [] })
      if (event === 'session.command' && input.method === 'run') {
        const sessionId = input.id === 'session-1' ? 'chat' : 'person-main-bot'
        send({ event: 'message.delta', session_id: sessionId, delta: 'hello ' })
        send({ event: 'message.delta', session_id: sessionId, delta: 'world' })
        send({ event: 'run.completed', session_id: sessionId, output: 'hello world' })
      }
    })
  })
  const manifest = { id: 'live', name: 'Live', version: '1.0.0', apiVersion: 1, permissions: ['ui', 'api.read', 'api.write'], client: 'client.mjs', views: [{ id: 'home', title: 'Live', slot: 'page' }] }
  const source = `export function mount(root,ctx){
    for(const [label,module,id] of [['Chat','sessions','chat'],['BOT','bots','person-main-bot']]){
      const button=document.createElement('button');button.textContent='Start '+label;
      const output=document.createElement('output');output.dataset.kind=label;
      button.onclick=async()=>{const session=await ctx.host[module].connect(id,event=>{if(event.event==='message.delta')output.textContent+=event.delta;if(event.event==='run.completed')output.dataset.complete='true'});await session.run('hello');await session.queue.insert('queued');await session.interactions.clarify('question','answer')};root.append(button,output)
    }
    const leave=document.createElement('button');leave.textContent='Leave';leave.onclick=()=>ctx.ui.navigate('/studio/plugins');root.append(leave)
  }`
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: 1, plugins: [{ manifest, status: 'active', enabled: true, config: {}, tools: [], commands: [], actions: [] }] } })
    if (path.endsWith('/client')) return route.fulfill({ json: { source } })
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'live', events: [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replace(/^\//, '')
  await page.route('**/__plugin_live__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_live__#/studio/plugins/live/home')
  const frame = page.frameLocator('.plugin-workspace iframe')
  await frame.getByRole('button', { name: 'Start Chat', exact: true }).click()
  await expect(frame.locator('output[data-kind="Chat"]')).toHaveText('hello world')
  await expect(frame.locator('output[data-kind="Chat"]')).toHaveAttribute('data-complete', 'true')
  await frame.getByRole('button', { name: 'Start BOT', exact: true }).click()
  await expect(frame.locator('output[data-kind="BOT"]')).toHaveText('hello world')
  expect(commands.filter(command => command.event === 'session.open').map(command => [command.input.sessionId, command.input.kind, command.input.pluginId])).toEqual([['chat', 'chat', 'live'], ['person-main-bot', 'bot', 'live']])
  await expect.poll(() => commands.filter(command => command.input.method === 'clarify.respond').length).toBe(2)
  await frame.getByRole('button', { name: 'Leave', exact: true }).click()
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect.poll(() => disconnected).toBe(true)
  expect(errors).toEqual([])
})

test('keeps the plugin center accessible when an installed manifest lacks current permission metadata', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: 1, plugins: [{
      manifest: { id: 'invalid', name: 'Invalid package', version: '0.1.0', apiVersion: 1 },
      source: '/fixture', status: 'failed', error: 'Invalid plugin permissions', enabled: true, config: {}, tools: [], commands: [], actions: [],
    }] } })
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'invalid', events: [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replace(/^\//, '')
  await page.route('**/__plugin_invalid__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_invalid__#/studio/plugins')
  await expect(page.getByRole('heading', { name: '插件中心', exact: true })).toBeVisible()
  await expect(page.locator('.plugin-card')).toContainText('Invalid package')
  await page.getByRole('button', { name: 'Agent 0', exact: true }).click()
  await expect(page.locator('.plugin-card')).toHaveCount(0)
  expect(errors).toEqual([])
})
