import { expect, test, type Page, type Locator } from '@playwright/test'
import { createHash } from 'node:crypto'
import AdmZip from 'adm-zip'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

async function painted(locator: Locator) {
  await expect(locator).toBeInViewport()
  await expect.poll(() => locator.evaluate(element => {
    let opacity = 1
    for (let node: Element | null = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity)
    return opacity
  })).toBe(1)
}

async function setup(page: Page, brightness = 'light', wallpaper = false) {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, { theme: { brightness,
    background: wallpaper ? { name: 'wall.png', mime: 'image/png', updatedAt: 1 } : null,
    appearance: { global: { opacity: 0.6 }, regions: { card: { opacity: wallpaper ? 0 : 0.8, blur: 8, radius: 12 }, input: { opacity: 0.5 }, overlay: { opacity: 0.85 } } },
  } })
  let revision = 1, fail = false, empty = false
  const calls: any[] = []
  const imports: Buffer[] = []
  const values = new Map([['first/native/', '{"theme":"light"}'], ['first/workspace/', '# Workspace instructions'], ['first/local/same/SKILL.md', '# Local skill'], ['first/shared/same/SKILL.md', '# Shared skill'], ['second/native/', 'second = true'], ['first/local/same/references/guide.md', '# Skill reference']])
  const instance = (id: string) => ({ id, agentTypeId: id === 'first' ? 'qwen' : 'custom.agent/type', revision, mode: id === 'first' ? 'scoped' : 'global' })
  await page.route('**/api/studio/agent-instances?*', route => route.fulfill({ json: { data: ['first', 'second'].map(instance) } }))
  await page.route('**/api/studio/agent-instances/*/skills/import?*', async route => {
    expect(new URL(route.request().url()).searchParams.get('profile')).toBe('research')
    expect(route.request().headers()['content-type']).toContain('multipart/form-data; boundary=')
    const body = route.request().postDataBuffer()!
    expect(body.toString()).toContain('name="locationId"\r\n\r\nlocal\r\n')
    expect(body.toString()).toContain('name="snapshot"\r\n\r\nsnapshot-first-1\r\n')
    imports.push(body)
    values.set('first/local/imported/SKILL.md', '# Imported native Skill')
    await route.fulfill({ json: { data: { name: 'imported', locationId: 'local', path: 'imported' } } })
  })
  await page.route('**/api/studio/agent-instances/*/resources?*', async route => {
    const body = route.request().postDataJSON(), id = new URL(route.request().url()).pathname.split('/')[4]
    calls.push({ id, ...body })
    expect(new URL(route.request().url()).searchParams.get('profile')).toBe('research')
    if (fail) return route.fulfill({ status: 409, json: { error: { message: 'Resource changed; reload before saving' } } })
    const skills = [{ id: 'local', name: 'Native skills', path: '/fixture/local', readOnly: false, scope: 'scoped' }, { id: 'shared', name: 'Shared skills', path: '/fixture/shared', readOnly: true, scope: 'shared' }]
    const configs = [{ id: 'native', name: 'settings.json', path: '/fixture/settings.json', kind: 'file', scope: 'scoped', readOnly: false }, { id: 'workspace', name: 'QWEN.md', path: '/fixture/QWEN.md', kind: 'file', scope: 'workspace', readOnly: true }]
    const files = [
      { kind: 'configs', locationId: 'native', path: '', absolutePath: '/fixture/settings.json', exists: true, readOnly: false },
      { kind: 'configs', locationId: 'workspace', path: '', absolutePath: '/fixture/QWEN.md', exists: true, readOnly: true },
      ...skills.flatMap(source => [...values.keys()].filter(key => key.startsWith(`${id}/${source.id}/`)).map(key => {
        const path = key.slice(`${id}/${source.id}/`.length)
        return { kind: 'skills', locationId: source.id, path, absolutePath: `${source.path}/${path}`, exists: true, readOnly: source.readOnly }
      })),
    ]
    if (body.action === 'list') return route.fulfill({ json: { data: { instanceId: id, configRevision: revision, snapshot: `snapshot-${id}-${revision}`, skills: empty ? [] : skills, configs: empty ? [] : configs, files: empty ? [] : files } } })
    if (body.action === 'review-skill' || body.action === 'remove-skill') {
      const prefix = `${id}/${body.locationId}/${body.path}/`, contents = [...values.entries()].filter(([key]) => key.startsWith(prefix)).sort()
      const etag = createHash('sha256').update(JSON.stringify(contents)).digest('hex')
      if (body.action === 'review-skill') return route.fulfill({ json: { data: { skill: { locationId: body.locationId, path: body.path, name: body.path,
        etag, files: contents.length, bytes: contents.reduce((total, [, value]) => total + value.length, 0) } } } })
      if (body.etag !== etag) return route.fulfill({ status: 409, json: { error: { message: 'Skill changed; review it again before deleting' } } })
      for (const [key] of contents) values.delete(key)
      return route.fulfill({ json: { data: { removed: true } } })
    }
    const key = `${id}/${body.locationId}/${body.path}`, entry = files.find(item => item.kind === body.kind && item.locationId === body.locationId && item.path === body.path)!
    expect(entry).toBeTruthy()
    if (body.action === 'write') { expect(body.etag).toBe(`etag-${values.get(key)}`); expect(entry.readOnly).toBe(false); values.set(key, body.content) }
    await route.fulfill({ json: { data: { file: { ...entry, content: values.get(key) || '', etag: `etag-${values.get(key)}` } } } })
  })
  return { ...api, calls, values, imports, fail: (value: boolean) => { fail = value }, empty: () => { empty = true }, revise: () => { revision++ } }
}

for (const mode of ['desktop light', 'mobile dark']) test(`imports a Skill into its chosen source and deletes the reviewed folder (${mode})`, async ({ page }, info) => {
  if (mode === 'mobile dark') await page.setViewportSize({ width: 390, height: 844 })
  const api = await setup(page, mode === 'mobile dark' ? 'dark' : 'light', mode === 'mobile dark')
  await page.goto('/#/studio/agents/qwen/skills?instance=first')
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  const modal = page.locator('.n-modal:visible').filter({ hasText: 'Import skill' })
  await expect(modal.getByLabel('Skill source', { exact: true })).toContainText('Native skills')
  await modal.getByText('Zip', { exact: true }).click()
  const zip = new AdmZip(); zip.addFile('SKILL.md', Buffer.from('# Imported native Skill'))
  await modal.locator('input[type=file]').setInputFiles({ name: 'imported.zip', mimeType: 'application/zip', buffer: zip.toBuffer() })
  await expect(modal.getByRole('radio', { name: 'Zip', exact: true })).toBeChecked()
  await expect(modal.getByText('imported.zip', { exact: true })).toBeVisible()
  await painted(modal.getByText('imported.zip', { exact: true }))
  await page.screenshot({ path: info.outputPath('managed-skill-import.png'), animations: 'disabled' })
  await modal.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(modal).toHaveCount(0)
  expect(api.imports).toHaveLength(1)
  if (mode === 'mobile dark') await page.locator('.sidebar-toggle').click()
  const imported = page.locator('.skill-item').filter({ has: page.locator('.skill-name', { hasText: /^\s*imported\s*$/ }) })
  await expect(imported).toBeVisible()
  await imported.getByRole('button', { name: 'Delete', exact: true }).click()
  const confirm = page.locator('.n-dialog:visible')
  await expect(confirm).toContainText('/fixture/local')
  await painted(confirm)
  expect(api.calls.filter(call => call.action === 'remove-skill')).toHaveLength(0)
  await page.screenshot({ path: info.outputPath('managed-skill-delete.png'), animations: 'disabled' })
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(imported).toHaveCount(0)
  expect(api.values.has('first/local/imported/SKILL.md')).toBe(false)
  expect(api.values.get('first/shared/same/SKILL.md')).toBe('# Shared skill')
  expect(api.unexpectedRequests).toEqual([])
})

test('retains a Skill changed after confirmation and invalidates delete dialogs on an instance switch', async ({ page }) => {
  const api = await setup(page)
  api.values.set('first/local/SKILL.md', '# Root Skill')
  await page.goto('/#/studio/agents/qwen/skills?instance=first')
  const local = page.locator('.skill-category').filter({ has: page.locator('.category-header[title*="/fixture/local"]') })
  const original = local.locator('.skill-item').filter({ has: page.locator('.skill-name', { hasText: /^\s*same\s*$/ }) })
  const root = local.locator('.skill-item').filter({ has: page.locator('.skill-name', { hasText: /^\s*\.\s*$/ }) })
  await expect(root.locator('.skill-action-btn')).toHaveCount(0)
  await original.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('.n-dialog:visible')).toContainText('/fixture/local')
  api.values.set('first/local/same/references/guide.md', 'Changed during confirmation')
  await page.locator('.n-dialog:visible').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText('Skill changed; review it again before deleting', { exact: false })).toBeVisible()
  expect(api.values.has('first/local/same/SKILL.md')).toBe(true)
  await original.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('.n-dialog:visible')).toBeVisible()
  await page.evaluate(() => { window.location.hash = '/studio/agents/qwen/skills?instance=second' })
  await expect(page).toHaveURL(/instance=second/)
  await expect(page.locator('.n-dialog:visible')).toHaveCount(0)
  expect(api.calls.filter(call => call.action === 'remove-skill')).toHaveLength(1)
  expect(api.values.has('first/local/same/SKILL.md')).toBe(true)
})

for (const brightness of ['light', 'dark']) for (const wallpaper of [false, true]) test(`existing config editor consumes multiple sources (${brightness}, wallpaper ${wallpaper})`, async ({ page }, info) => {
  if (wallpaper) await page.setViewportSize({ width: 390, height: 844 })
  const api = await setup(page, brightness, wallpaper)
  await page.goto('/#/studio/agents/qwen/settings?instance=first')
  const editor = page.locator('.settings-editor-panel textarea')
  await expect(editor).toHaveValue('{"theme":"light"}')
  await editor.fill('{"theme":"dark"}')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => api.values.get('first/native/')).toBe('{"theme":"dark"}')
  await page.getByLabel('Configuration file', { exact: true }).click()
  await page.getByText( 'QWEN.md · /fixture/QWEN.md', { exact: true }).click()
  await expect(editor).toHaveValue('# Workspace instructions')
  await expect(editor).toHaveAttribute('readonly')
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await expect(page.locator('.n-base-select-menu:visible')).toHaveCount(0)
  await expect(page.locator('.n-message:visible')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('resource-config-readonly.png') })
  await expect(page.getByLabel('Agent instance', { exact: true })).toHaveCount(0)
  await page.evaluate(() => { window.location.hash = '/studio/agents/qwen/settings?instance=second' })
  await expect(editor).toHaveValue('second = true')
  await expect(page).toHaveURL(/instance=second/)
  await editor.fill('second = false')
  api.fail(true)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Resource changed; reload before saving')).toBeVisible()
  await expect(editor).toHaveValue('second = false')
  api.fail(false); api.empty()
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByText('No resources at these locations')).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})

test('existing Skills editor preserves duplicate sources, saves locally and keeps shared skills read-only', async ({ page }) => {
  const api = await setup(page)
  await page.goto('/#/studio/agents/qwen/skills?instance=first')
  await expect(page.locator('.skill-item')).toHaveCount(2)
  await expect(page.locator('.skill-detail')).toContainText('Local skill')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.locator('.skill-detail textarea').fill('# Edited local skill')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => api.values.get('first/local/same/SKILL.md')).toBe('# Edited local skill')
  await page.getByRole('button', { name: 'references/guide.md', exact: true }).click()
  await expect(page.locator('.skill-detail')).toContainText('Skill reference')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.locator('.skill-detail textarea').fill('# Edited reference')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => api.values.get('first/local/same/references/guide.md')).toBe('# Edited reference')
  await page.locator('.skill-item').nth(1).click()
  await expect(page.locator('.skill-detail')).toContainText('Shared skill')
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeVisible()
  await page.getByTestId('coding-agent-config-settings').click()
  await expect(page).toHaveURL(/settings\?instance=first/)
  await expect(page.locator('.settings-editor-panel textarea')).toHaveValue('{"theme":"light"}')
  expect(api.unexpectedRequests).toEqual([])
})
