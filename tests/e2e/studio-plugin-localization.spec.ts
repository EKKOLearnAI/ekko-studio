import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { PLUGIN_LOCALES } from '../../packages/plugin-sdk/src/localization.mjs'
import { templateMessages } from '../../packages/plugin-sdk/template/client.mjs'

test('legacy built-in preview URL opens the plugin center with no preview plugin installed', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('hermes_api_key', `test.${btoa(JSON.stringify({ sub: '1', role: 'super_admin' }))}.fixture`)
    localStorage.setItem('hermes_active_profile_name', 'default')
  })
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/') || url.pathname === '/health', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/health') return route.fulfill({ json: { status: 'ok' } })
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path === '/api/hermes/profiles') return route.fulfill({ json: { profiles: [{ name: 'default', active: true }] } })
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: 1, plugins: [] } })
    return route.fulfill({ json: {} })
  })
  await page.goto('/#/hermes/version-preview')
  await expect(page).toHaveURL(/#\/studio\/plugins$/)
})

test('settings entries preserve plugin logos and localized names while legacy packages and old page links remain usable', async ({ page }, testInfo) => {
  const icon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUioAAAAASUVORK5CYII='
  const installed = (id: string, name: string, extra = {}) => ({ manifest: { id, name, description: '旧插件描述', apiVersion: 1, version: '1.0.0', permissions: ['ui'], client: 'client.mjs',
    views: [{ id: 'preview', title: name, slot: 'settings' }], navigation: { settings: [{ viewId: 'preview', icon }] }, ...extra },
    enabled: true, status: 'active', config: {}, tools: [], commands: [], actions: [] })
  const preview = installed('version-preview', 'Version Preview', { description: 'Preview Studio versions.', icon,
    i18n: { en: { name: 'Version Preview', description: 'Preview Studio versions.', views: { preview: 'Version Preview' } },
      zh: { name: '版本预览', description: '预览 Studio 版本。', views: { preview: '版本预览' } } } })
  const displayNames = { 'zh-TW': '版本預覽', ja: 'バージョンプレビュー', ko: '버전 미리보기', fr: 'Aperçu de version', es: 'Vista previa de versión', de: 'Versionsvorschau', pt: 'Prévia de versão', ru: 'Предпросмотр версий', ar: 'معاينة الإصدار', tr: 'Sürüm önizlemesi' }
  for (const locale of PLUGIN_LOCALES) if (!preview.manifest.i18n[locale]) {
    const labels = templateMessages[locale]
    preview.manifest.i18n[locale] = { name: displayNames[locale], description: labels.description.replaceAll('{id}', 'preview'), views: { preview: displayNames[locale] } }
  }
  const legacy = installed('legacy', '旧插件固定名称')
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/') || url.pathname === '/health', route => {
    const requestUrl = new URL(route.request().url()), path = requestUrl.pathname
    if (path === '/api/studio/plugins' && requestUrl.searchParams.has('page')) return route.fulfill({ json: { ok: true, data: { total: 2, page: 1, pageSize: 100, list: [
      { id: 'a'.repeat(64), name: 'Market preview', description: 'Market description', repository: 'https://github.com/example/preview', permissions: ['ui'], i18n: { en: { name: 'Market preview', description: 'Market description' }, zh: { name: '市场预览', description: '市场预览描述' } } },
      { id: 'b'.repeat(64), name: 'Legacy market', description: 'Legacy market description', repository: 'https://github.com/example/legacy', permissions: ['ui'] },
    ] } } })
    if (path === '/health') return route.fulfill({ json: { status: 'ok' } })
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: 1, plugins: [preview, legacy] } })
    if (path.endsWith('/client')) return route.fulfill({ json: { source: `export function mount(root,ctx){root.textContent = ctx.locale === 'zh' ? '插件预览内容' : 'Plugin preview content'}` } })
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'i18n', events: [] } })
    if (path === '/api/hermes/profiles') return route.fulfill({ json: { profiles: [{ name: 'default', active: true }] } })
    if (path === '/api/studio/agents') return route.fulfill({ json: { agents: [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replace(/^\//, '')
  await page.route('**/__plugin_i18n__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  // Released plugin links remain usable after their view moves into settings.
  await page.goto('/__plugin_i18n__#/studio/plugins/version-preview/preview')
  await expect(page).toHaveURL(/#\/studio\/plugin-settings\/version-preview\/preview$/)
  const sidebar = page.locator('.sidebar-nav')
  await expect(sidebar.getByRole('link', { name: '版本预览', exact: true })).toBeVisible()
  await expect(sidebar.getByRole('link', { name: '版本预览', exact: true }).locator('img')).toHaveAttribute('src', icon)
  await expect(sidebar.getByRole('link', { name: '旧插件固定名称', exact: true })).toBeVisible()
  await expect(page.locator('.workspace-heading h2')).toHaveText('版本预览')
  await expect(page.frameLocator('.plugin-workspace iframe').locator('#root')).toHaveText('插件预览内容')
  await page.evaluate(() => (window as any).pluginFixture.locale('en'))
  await expect(sidebar.getByRole('link', { name: 'Version Preview', exact: true })).toBeVisible()
  await expect(sidebar.getByRole('link', { name: '旧插件固定名称', exact: true })).toBeVisible()
  await expect(page.locator('.workspace-heading h2')).toHaveText('Version Preview')
  await expect(page.frameLocator('.plugin-workspace iframe').locator('#root')).toHaveText('Plugin preview content')
  await page.screenshot({ path: testInfo.outputPath('settings-en.png') })
  for (const locale of PLUGIN_LOCALES) {
    await page.evaluate(locale => (window as any).pluginFixture.locale(locale), locale)
    await expect(sidebar.getByRole('link', { name: preview.manifest.i18n[locale].name, exact: true })).toBeVisible()
    await expect(page.locator('.workspace-heading h2')).toHaveText(preview.manifest.i18n[locale].name)
    await expect(page.frameLocator('.plugin-workspace iframe').locator('html')).toHaveAttribute('lang', locale)
    await expect(page.frameLocator('.plugin-workspace iframe').locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr')
    await page.evaluate(() => (window as any).pluginFixture.navigate('/studio/plugins'))
    await expect(page.getByTestId('plugin-card-version-preview').locator('.card-description')).toHaveText(preview.manifest.i18n[locale].description)
    await page.evaluate(() => (window as any).pluginFixture.navigate('/studio/plugin-settings/version-preview/preview'))
  }
  await page.evaluate(() => (window as any).pluginFixture.locale('en'))
  await page.evaluate(() => (window as any).pluginFixture.navigate('/studio/plugins'))
  await expect(page.locator('.card-description').filter({ hasText: 'Preview Studio versions.' })).toBeVisible()
  await expect(page.locator('.card-description').filter({ hasText: '旧插件描述' })).toBeVisible()
  await page.evaluate(() => (window as any).pluginFixture.locale('zh'))
  await expect(page.locator('.card-description').filter({ hasText: '预览 Studio 版本。' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('center-zh.png') })
  await page.getByRole('tab', { name: /^全部/ }).click()
  await expect(page.locator('.card-title').filter({ hasText: '市场预览' })).toBeVisible()
  await expect(page.locator('.card-description').filter({ hasText: '市场预览描述' })).toBeVisible()
  await page.evaluate(() => (window as any).pluginFixture.locale('en'))
  await expect(page.locator('.card-title').filter({ hasText: 'Market preview' })).toBeVisible()
  await expect(page.locator('.card-description').filter({ hasText: 'Legacy market description' })).toBeVisible()
  await page.evaluate(() => (window as any).pluginFixture.navigate('/studio/plugins/version-preview'))
  await expect(page).toHaveURL(/#\/studio\/plugin-settings\/version-preview\/preview$/)
})
