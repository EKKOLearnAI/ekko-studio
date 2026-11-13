import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

async function setup(page: Page) {
  const errors: string[] = [], profiles: string[] = [], saved: unknown[] = []
  const state = { status: 200, empty: false }
  page.on('pageerror', error => errors.push(error.message))
  const manifest = { id: 'picker', name: 'Picker demo', version: '1.0.0', apiVersion: 1, permissions: ['ui'], client: 'client.mjs',
    views: [{ id: 'home', title: 'Picker', slot: 'page' }] }
  const source = `export function mount(root,ctx){
    let current={provider:'custom:test',model:'model-a'};
    const output=document.createElement('output');output.id='result';
    const choose=document.createElement('button');choose.textContent='Choose model';choose.onclick=async()=>{
      output.textContent='pending';
      try{const result=await ctx.ui.selectModel({current});output.textContent=JSON.stringify(result);if(result){current=result;await ctx.rpc.call('save-model',result)}}
      catch(error){output.textContent='error: '+error.message}
    };
    const concurrent=document.createElement('button');concurrent.textContent='Choose twice';concurrent.onclick=async()=>{
      output.textContent='pending';const results=await Promise.allSettled([ctx.ui.selectModel(),ctx.ui.selectModel()]);
      output.textContent=JSON.stringify(results.map(result=>result.status==='fulfilled'?{value:result.value}:{error:result.reason.message}));
    };
    root.append(choose,concurrent,output);
  }`
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: 1, plugins: [{ manifest, status: 'active', enabled: true, config: {}, tools: [], commands: [], actions: [] }] } })
    if (path.endsWith('/client')) return route.fulfill({ json: { source } })
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'picker', events: [] } })
    if (path.endsWith('/invoke')) { saved.push(route.request().postDataJSON().input); return route.fulfill({ json: { result: { ok: true } } }) }
    if (path === '/api/hermes/available-models') {
      const profile = url.searchParams.get('profile') || ''; profiles.push(profile)
      if (state.status !== 200) return route.fulfill({ status: state.status, json: { error: 'Profile access denied' } })
      return route.fulfill({ json: { default: 'model-a', default_provider: 'custom:test', allProviders: [],
        groups: state.empty ? [] : [{ provider: 'custom:test', label: `${profile} provider`, models: ['disabled-model', 'model-a', 'model-b'],
          api_key: 'host-only-secret', base_url: 'https://host-only.invalid', api_mode: 'chat_completions',
          api_mode_by_model: { 'model-a': 'codex_responses', 'model-b': 'anthropic_messages' },
          model_meta: { 'disabled-model': { disabled: true }, 'model-a': { alias: 'Friendly model' } } }],
        custom_models: { 'custom:test': ['my-custom-model'] }, model_aliases: { 'custom:test': { 'model-a': 'Friendly model' } } } })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replace(/^\//, '')
  await page.route('**/__plugin_model_picker__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_model_picker__#/studio/plugins/picker/home')
  const frame = page.frameLocator('.plugin-workspace iframe')
  await expect(frame.getByRole('button', { name: 'Choose model', exact: true })).toBeVisible()
  return { frame, modal: page.locator('.model-cascader-modal'), state, profiles, saved, errors }
}

test('opens the shared host picker from an isolated plugin and returns a canonical selection or cancellation', async ({ page }, testInfo) => {
  const { frame, modal, profiles, saved, errors } = await setup(page)
  const choose = frame.getByRole('button', { name: 'Choose model', exact: true })
  await choose.click()
  await expect(modal).toBeVisible()
  await expect(modal).toHaveAttribute('aria-label', 'Picker demo · 选择模型...')
  await expect(modal.getByRole('menuitemradio', { name: /disabled-model/ })).toBeDisabled()
  await expect(modal.getByRole('menuitemradio', { name: 'Friendly model', exact: true })).toHaveAttribute('aria-checked', 'true')
  await page.screenshot({ path: testInfo.outputPath('plugin-model-picker-light.png') })
  await modal.getByPlaceholder('搜索模型...').fill('Friendly')
  await expect(modal.getByRole('menuitemradio')).toHaveCount(1)
  await modal.getByRole('menuitemradio', { name: 'Friendly model', exact: true }).click()
  await expect(modal).toHaveCount(0)
  const selection = { profile: 'default', provider: 'custom:test', model: 'model-a', apiMode: 'codex_responses' }
  await expect(frame.locator('#result')).toHaveText(JSON.stringify(selection))
  await expect.poll(() => saved).toEqual([selection])
  expect(profiles).toEqual(['default'])

  await page.evaluate(async () => {
    const fixture = (window as any).pluginFixture
    await fixture.theme(true); fixture.wallpaper(true)
    fixture.appearance({ brightness: 'dark', appearance: { global: { opacity: .7 }, regions: { card: { opacity: 0, blur: 4, radius: 12, backgroundColor: '#315a76' } } } })
  })
  await choose.click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(modal).toBeVisible()
  expect(await modal.evaluate(el => el.getBoundingClientRect().width <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('plugin-model-picker-dark-mobile.png') })
  await modal.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(frame.locator('#result')).toHaveText('null')
  expect(saved).toHaveLength(1)
  expect(errors).toEqual([])
})

test('settles concurrent calls and closes the old picker when the plugin Profile changes', async ({ page }) => {
  const { frame, modal, profiles, errors } = await setup(page)
  await frame.getByRole('button', { name: 'Choose twice', exact: true }).click()
  await expect(modal).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(frame.locator('#result')).toHaveText(JSON.stringify([{ value: null }, { error: 'A model picker is already open for this plugin view' }]))
  await frame.getByRole('button', { name: 'Choose model', exact: true }).click()
  await expect(modal).toBeVisible()
  await page.evaluate(() => (window as any).pluginFixture.profile('team'))
  await expect(modal).toHaveCount(0)
  await frame.getByRole('button', { name: 'Choose model', exact: true }).click()
  await expect(modal.getByRole('menuitem', { name: /team provider/ })).toBeVisible()
  await modal.getByRole('menuitemradio', { name: /my-custom-model/ }).click()
  await expect(frame.locator('#result')).toHaveText(JSON.stringify({ profile: 'team', provider: 'custom:test', model: 'my-custom-model' }))
  expect(profiles).toEqual(['default', 'default', 'team'])
  expect(errors).toEqual([])
})

test('returns catalog errors to the plugin and permits cancelling an empty catalog after retry', async ({ page }) => {
  const { frame, modal, state, errors } = await setup(page)
  state.status = 403
  await frame.getByRole('button', { name: 'Choose model', exact: true }).click()
  await expect(frame.locator('#result')).toContainText('Profile access denied')
  await expect(modal).toHaveCount(0)
  state.status = 200; state.empty = true
  await frame.getByRole('button', { name: 'Choose model', exact: true }).click()
  await expect(modal.getByText('无模型', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(frame.locator('#result')).toHaveText('null')
  expect(errors).toEqual([])
})
