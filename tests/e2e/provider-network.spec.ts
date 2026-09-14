import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY, TEST_MODEL_GROUP } from './fixtures'

for (const viewport of [{ width: 1280, height: 960 }, { width: 390, height: 844 }]) {
  test(`edits, tests, restores and clears provider network options at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const provider = 'custom:network-test'
    const editableFields = [
      ...TEST_MODEL_GROUP.editable_fields,
      'api_mode', 'extra_headers', 'preserve_client_identity', 'proxy_url',
    ]
    const api = await mockHermesApi(page, {
      initialProfileName: 'research',
      modelGroups: [{
        ...TEST_MODEL_GROUP, provider, label: 'Network Test', builtin: false, editable_fields: editableFields,
      }],
      providerEditor: {
        id: provider, label: 'Network Test', builtin: false, source: 'custom_providers',
        api_mode: 'codex_responses', editable_fields: editableFields,
      },
    })
    await page.goto('/#/hermes/models')
    const editor = page.getByRole('dialog')
    const openEditor = async () => {
      await page.getByRole('button', { name: 'Edit', exact: true }).click()
      await editor.getByText('Advanced provider settings', { exact: true }).click()
    }
    await openEditor()
    const identity = editor.getByRole('checkbox', { name: 'Preserve Codex / Claude client identity' })
    const proxy = editor.locator('input[name="provider-proxy-url"]')
    const extraHeaders = editor.locator('textarea[name="provider-extra-headers"]')
    await expect(identity).not.toBeChecked()
    await expect(proxy).toHaveValue('')
    await expect(proxy).toHaveAttribute('type', 'password')
    await expect(proxy).toHaveAttribute('autocomplete', 'new-password')

    await extraHeaders.fill('{broken')
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Extra headers must be a JSON object with string values.')).toBeVisible()
    expect(api.requests.filter(request => request.method === 'PATCH')).toHaveLength(0)
    expect(api.requests.filter(request => request.pathname.endsWith('/editor/test'))).toHaveLength(0)

    await identity.check()
    await proxy.fill('http://127.0.0.1:19181')
    await extraHeaders.fill('{"X-Route":"preview"}')
    await expect(page.getByText('Extra headers must be a JSON object with string values.')).toBeHidden()
    await expect(editor.locator('input[name="provider-api-key-replacement"]')).toHaveValue('')
    const bounds = await editor.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`provider-network-${viewport.width}.png`) })

    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(editor).toHaveCount(0)
    const saved = api.requests.find(request => request.method === 'PATCH' && request.pathname.endsWith('/editor'))!
    const probed = api.requests.find(request => request.pathname.endsWith('/editor/test'))!
    const expectedPatch = {
      preserve_client_identity: true, proxy_url: 'http://127.0.0.1:19181',
      extra_headers: { 'X-Route': 'preview' }, credential_action: 'keep',
    }
    expect(JSON.parse(saved.postData!)).toMatchObject(expectedPatch)
    expect(JSON.parse(probed.postData!)).toMatchObject(expectedPatch)
    expect(JSON.parse(saved.postData!)).not.toHaveProperty('api_key')
    expect(probed.headers['x-hermes-profile']).toBe('research')

    await openEditor()
    await expect(identity).toBeChecked()
    await expect(proxy).toHaveValue('http://127.0.0.1:19181')
    expect(JSON.parse(await extraHeaders.inputValue())).toEqual({ 'X-Route': 'preview' })
    await proxy.fill('http://discarded.invalid:8080')
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    await openEditor()
    await expect(proxy).toHaveValue('http://127.0.0.1:19181')

    await identity.uncheck()
    await proxy.fill('')
    await extraHeaders.fill('')
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(editor).toHaveCount(0)
    const cleared = api.requests.filter(request => request.method === 'PATCH' && request.pathname.endsWith('/editor')).at(-1)!
    expect(JSON.parse(cleared.postData!)).toMatchObject({
      preserve_client_identity: false, proxy_url: null, extra_headers: null,
    })
    await openEditor()
    await expect(identity).not.toBeChecked()
    await expect(proxy).toHaveValue('')
    await expect(extraHeaders).toHaveValue('')
    expect(errors).toEqual([])
    expect(api.unexpectedRequests).toEqual([])
  })
}
