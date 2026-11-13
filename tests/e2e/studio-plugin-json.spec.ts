import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test('rejects non-JSON plugin data before HTTP serialization and allows a corrected request', async ({ page }) => {
  const inputs: unknown[] = []
  const manifest = { id: 'json-check', name: 'JSON check', version: '1.0.0', apiVersion: 1, permissions: ['ui', 'api.write', 'storage.client'], client: 'client.mjs', views: [{ id: 'home', title: 'JSON check', slot: 'page' }] }
  const source = `export function mount(root, ctx) {
    const output = document.createElement('output'); output.id = 'result';
    const invalid = document.createElement('button'); invalid.textContent = 'Invalid requests';
    invalid.onclick = async () => {
      const operations = [
        () => ctx.rpc.call('save', {count: NaN}),
        () => ctx.host.models.respond({model: 'local', input: {count: Infinity}}),
        () => ctx.state.plugin.set('record', {missing: undefined})
      ];
      const results = [];
      for (const operation of operations) { try {await operation(); results.push('accepted')} catch(error) {results.push(error.message)} }
      output.textContent = JSON.stringify(results);
    };
    const valid = document.createElement('button'); valid.textContent = 'Valid request';
    valid.onclick = async () => {const result = await ctx.rpc.call('save', {count: 1}); output.textContent = JSON.stringify(result)};
    root.append(invalid, valid, output);
  }`
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: 1, plugins: [{ manifest, status: 'active', enabled: true, config: {}, tools: [], commands: [], actions: [] }] } })
    if (path.endsWith('/client')) return route.fulfill({ json: { source } })
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'json', events: [] } })
    if (/\/(invoke|api|storage)$/.test(path)) {
      inputs.push(route.request().postDataJSON())
      return route.fulfill({ json: { result: { ok: true } } })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replace(/^\//, '')
  await page.route('**/__plugin_json__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_json__#/studio/plugins/json-check/home')
  const frame = page.frameLocator('.plugin-workspace iframe')
  await frame.getByRole('button', { name: 'Invalid requests', exact: true }).click()
  await expect(frame.locator('#result')).toContainText('JSON')
  const results = JSON.parse(await frame.locator('#result').innerText())
  expect(results).toHaveLength(3)
  expect(results.every((error: string) => error.includes('JSON'))).toBe(true)
  expect(inputs).toHaveLength(0)
  await frame.getByRole('button', { name: 'Valid request', exact: true }).click()
  await expect(frame.locator('#result')).toHaveText('{"ok":true}')
  expect(inputs).toEqual([expect.objectContaining({ input: { count: 1 } })])
})
