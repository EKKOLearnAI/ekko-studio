import AdmZip from 'adm-zip'
import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('opens Cursor native settings from Agent Manager and saves the real configuration', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  let content = JSON.stringify({ version: 1, editor: { vimMode: false }, permissions: { allow: [], deny: [] } })
  const keys: string[] = []
  await page.route('**/api/coding-agents/cursor/config-files/*', async route => {
    const key = new URL(route.request().url()).pathname.split('/').at(-1)!
    keys.push(key)
    expect(key).toBe('settings')
    if (route.request().method() === 'PUT') content = route.request().postDataJSON().content
    await route.fulfill({ json: { key, content, path: '~/.cursor/cli-config.json', absolutePath: '/home/test/.cursor/cli-config.json', exists: true, language: 'json' } })
  })
  await page.goto('/#/studio/agents')
  await page.getByTestId('agent-settings-cursor').click()
  await expect(page).toHaveURL(/\/studio\/agents\/cursor\/settings/)
  const editor = page.locator('.settings-editor-panel')
  await expect(editor).toHaveCount(1)
  await expect(editor.locator('textarea')).toHaveAttribute('placeholder', '~/.cursor/cli-config.json')
  const next = JSON.stringify({ version: 1, editor: { vimMode: true }, notifications: true })
  await editor.locator('textarea').fill(next)
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => content).toBe(next)
  await page.reload()
  await expect(editor.locator('textarea')).toHaveValue(next)
  expect(new Set(keys)).toEqual(new Set(['settings']))
  expect(api.unexpectedRequests).toEqual([])
})

test('navigates to Cursor Skills and imports, edits and deletes without calling Hermes targets', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  let imported = false
  let deleted = false
  let content = '---\nname: cursor-demo\ndescription: Cursor example\n---\nOriginal instructions'
  await page.route('**/api/coding-agents/cursor/config-files/settings', route => route.fulfill({ json: {
    key: 'settings', content: '{}', path: '~/.cursor/cli-config.json', exists: false, language: 'json',
  } }))
  await page.route('**/api/hermes/skills**', async route => {
    const url = new URL(route.request().url())
    if (!url.searchParams.has('target')) return route.fallback()
    expect(url.searchParams.get('target')).toBe('cursor')
    const method = route.request().method()
    if (url.pathname.endsWith('/import')) {
      expect(method).toBe('POST')
      expect(route.request().postDataBuffer()?.toString()).toContain('cursor-demo.zip')
      imported = true
      return route.fulfill({ json: { success: true, name: 'cursor-demo' } })
    }
    if (method === 'PUT') {
      content = route.request().postDataJSON().content
      return route.fulfill({ json: { success: true } })
    }
    if (method === 'DELETE') {
      deleted = true
      return route.fulfill({ json: { success: true } })
    }
    if (url.pathname === '/api/hermes/skills') {
      return route.fulfill({ json: { categories: imported && !deleted ? [{ name: 'misc', skills: [{
        name: 'cursor-demo', description: 'Cursor example', source: 'local', readonly: false,
      }] }] : [], archived: [] } })
    }
    return route.fulfill({ json: url.pathname.endsWith('/files') ? { files: [] } : { content } })
  })
  await page.goto('/#/studio/agents/cursor/settings')
  await page.locator('a[href="#/studio/agents/cursor/skills"]').click()
  await expect(page).toHaveURL(/\/cursor\/skills/)
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await page.locator('.n-modal').getByText('Zip', { exact: true }).click()
  const zip = new AdmZip()
  zip.addFile('cursor-demo/SKILL.md', Buffer.from(content))
  await page.locator('.n-modal input[type=file]').setInputFiles({ name: 'cursor-demo.zip', mimeType: 'application/zip', buffer: zip.toBuffer() })
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
  const skill = page.locator('.skill-item').filter({ hasText: 'cursor-demo' })
  await expect(skill).toBeVisible()
  await skill.click()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const edited = content.replace('Original instructions', 'Updated Cursor instructions')
  await page.locator('.skill-detail textarea').fill(edited)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => content).toBe(edited)
  await skill.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.locator('.n-dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(skill).toHaveCount(0)
  expect(deleted).toBe(true)
  expect(api.unexpectedRequests).toEqual([])
})
