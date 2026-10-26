import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

const draft = { version: 1, name: 'Example Relay', baseUrl: 'https://relay.example/v1',
  model: 'example-model', apiKey: 'fixture-import-secret', apiMode: 'codex_responses' }
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const importPath = (value: unknown = draft) => `/#/hermes/models?modelProfile=research&importProvider=${encoded(value)}`

test('previews a link, strips its credential fragment and cancels without writes or provider requests', async ({ page }) => {
  await authenticate(page)
  const api = await mockHermesApi(page)
  const urls: string[] = []
  page.on('request', req => urls.push(req.url()))
  await page.goto(importPath())
  const modal = page.getByRole('dialog')
  await expect(modal).toContainText('Import provider')
  await expect(modal.locator('input[name="import-provider-name"]')).toHaveValue(draft.name)
  const key = modal.locator('input[name="import-provider-api-key"]')
  await expect(key).toHaveAttribute('type', 'password')
  await expect(key).toHaveValue(draft.apiKey)
  await expect(page).not.toHaveURL(/importProvider|fixture-import-secret/)
  expect(urls.some(url => url.includes('relay.example') || url.includes(encoded(draft)))).toBe(false)
  expect(api.requests.some(r => r.method === 'POST' && r.pathname === '/api/hermes/config/providers')).toBe(false)
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(draft.apiKey)
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(modal).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('requires confirmation and refuses duplicate names before an explicit renamed retry', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  const attempts: Array<{ body: any; profile?: string }> = []
  await page.route('**/api/hermes/config/providers', async route => {
    attempts.push({ body: route.request().postDataJSON(), profile: route.request().headers()['x-hermes-profile'] })
    await route.fulfill({ status: attempts.length === 1 ? 409 : 200,
      json: attempts.length === 1 ? { error: 'Provider already exists' } : { success: true } })
  })
  await page.goto(importPath())
  const modal = page.getByRole('dialog')
  await expect(modal).toBeVisible()
  expect(attempts).toHaveLength(0)
  await modal.getByRole('button', { name: 'Confirm import' }).click()
  await expect(page.getByText('This provider name already exists.', { exact: false })).toBeVisible()
  await expect(modal).toBeVisible()
  expect(attempts[0]).toEqual({ profile: 'research', body: {
    name: draft.name, base_url: draft.baseUrl, api_key: draft.apiKey, model: draft.model,
    api_mode: draft.apiMode, create_only: true,
  } })
  await modal.locator('input[name="import-provider-name"]').fill('Another Relay')
  await modal.getByRole('button', { name: 'Confirm import' }).click()
  await expect(modal).toHaveCount(0)
  expect(attempts).toHaveLength(2)
  expect(attempts[1].body.name).toBe('Another Relay')
})

test('scrubs the payload before login and opens confirmation after login', async ({ page }) => {
  const api = await mockHermesApi(page)
  await page.goto(importPath())
  await expect(page.locator('.login-form')).toBeVisible()
  await expect(page).not.toHaveURL(/importProvider|fixture-import-secret/)
  await page.getByPlaceholder('Username', { exact: true }).fill('playwright')
  await page.getByPlaceholder('Password', { exact: true }).fill('fixture-password')
  await page.locator('.login-form button[type="submit"]').click()
  await expect(page.getByRole('dialog')).toContainText('Import provider')
  expect(api.requests.some(r => r.method === 'POST' && r.pathname === '/api/hermes/config/providers')).toBe(false)
})

test('rejects unsupported payloads without sending their contents to any endpoint', async ({ page }) => {
  await authenticate(page)
  const api = await mockHermesApi(page)
  await page.goto(importPath({ ...draft, command: 'untrusted-command' }))
  await expect(page.getByText('Invalid or unsupported provider import link.')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page).not.toHaveURL(/importProvider/)
  expect(JSON.stringify(api.requests)).not.toContain('untrusted-command')
})

test('completes a minimal draft only after an explicit model fetch', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  const probes: any[] = []
  const saves: any[] = []
  await page.route('**/api/hermes/provider-models', async route => {
    probes.push(route.request().postDataJSON())
    await route.fulfill({ json: { models: ['fixture-chat-model'] } })
  })
  await page.route('**/api/hermes/config/providers', async route => {
    saves.push(route.request().postDataJSON())
    await route.fulfill({ json: { success: true } })
  })
  await page.goto(importPath({ version: 1, baseUrl: draft.baseUrl, apiKey: draft.apiKey }))
  const modal = page.getByRole('dialog')
  await expect(modal.locator('input[name="import-provider-name"]')).toHaveValue('Relay.example')
  expect(probes).toHaveLength(0)
  await modal.getByRole('button', { name: 'Confirm import' }).click()
  expect(saves).toHaveLength(0)
  await modal.getByRole('button', { name: 'Fetch', exact: true }).click()
  await expect(modal).toContainText('fixture-chat-model')
  expect(probes).toEqual([{ base_url: draft.baseUrl, api_key: draft.apiKey, update_cache: false }])
  await modal.getByRole('button', { name: 'Confirm import' }).click()
  await expect(modal).toHaveCount(0)
  expect(saves[0]).toMatchObject({ name: 'Relay.example', model: 'fixture-chat-model', create_only: true })
})

test('imports apiMode auto as Auto (match model) and saves without a fixed API mode', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  const bodies: any[] = []
  await page.route('**/api/hermes/config/providers', async route => {
    bodies.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, json: { success: true } })
  })
  await page.goto(importPath({ ...draft, apiMode: 'auto' }))
  const modal = page.getByRole('dialog')
  await expect(modal).toContainText('Auto (match model)')
  await modal.getByRole('button', { name: 'Confirm import' }).click()
  await expect(modal).toHaveCount(0)
  expect(bodies).toHaveLength(1)
  expect(bodies[0].api_mode).toBeNull()
})
