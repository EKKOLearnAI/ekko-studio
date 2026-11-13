import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

const platform = 'https://token.example.test'
const token = 'fixture.test.session'
const account = { id: 9, username: 'existing', role: 'admin', wechat_bound: true, phone_number: '5551234567' }
const session = {
  token, userId: account.id, user: account, activeProfile: 'u_42',
  theme: { fontSize: 14, textColor: null, accentColor: null, background: null, updatedAt: 0 },
}
const apiKey = 'fixture-device-key'
const devicePayload = { api_base: platform, api_key: apiKey, models: ['example-model'], device_id: 2, device_name: 'Hermes' }

async function open(page: Page, hash = '', authenticated = false) {
  const fixture = '/@fs/' + resolve('tests/e2e/fixtures/wechat-account.ts').replace(/^\//, '')
  await page.route(url => url.pathname === '/wechat-account-test', route => route.fulfill({
    contentType: 'text/html',
    body: `<div id="app"></div><script type="module" src="${fixture}"></script>`,
  }))
  await page.route('**/api/auth/status', route => route.fulfill({ json: {
    hasPasswordLogin: true, hasUsers: true, tokenPlatformBaseUrl: platform,
  } }))
  if (authenticated) await page.addInitScript(value => localStorage.setItem('hermes_api_key', value), token)
  await page.goto('/wechat-account-test' + hash)
}

async function mockApproval(page: Page) {
  await page.route(platform + '/api/device-login/request', route => route.fulfill({
    headers: { 'access-control-allow-origin': '*' },
    json: { success: true, data: {
      login_id: 'scan-2', appid: 'wx-example', state: 'state-2', redirect_uri: platform + '/callback',
    } },
  }))
  await page.route(platform + '/api/device-login/status?*', route => route.fulfill({
    headers: { 'access-control-allow-origin': '*' },
    json: { success: true, data: {
      status: 'approved', device: { device_id: 2, name: 'Hermes' },
      api: { api_base: platform, api_key: apiKey, models: ['example-model'] },
    } },
  }))
}

test('a previously linked WeChat login restores the account workspace before redirect', async ({ page }) => {
  await mockApproval(page)
  await page.route('**/api/auth/device-login', async route => {
    expect(route.request().postDataJSON()).toEqual(devicePayload)
    expect(route.request().headers().authorization).toBeUndefined()
    await route.fulfill({ json: session })
  })
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: account } }))
  await open(page, '#/?redirect=/hermes/settings')
  await expect(page.getByRole('button', { name: 'Login', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Sign in with WeChat' }).click()
  await expect(page.getByRole('link', { name: 'Open WeChat Login Page' })).toHaveAttribute('href', /^https:\/\/open\.weixin\.qq\.com\/connect\/qrconnect\?/)
  await expect(page).toHaveURL(/#\/hermes\/settings$/)
  await expect(page.getByText('WeChat linked', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('hermes_active_profile_name'))).toBe('u_42')
  expect(await page.evaluate(() => localStorage.getItem('hermes_api_key'))).toBe(token)
})

test('an unbound scan requires the existing local account password to link', async ({ page }) => {
  await mockApproval(page)
  await page.route('**/api/auth/device-login', route => route.fulfill({ json: {
    status: 'needs_choice',
    profile: { display_name: 'Example', phone: null },
    options: ['create_local_user', 'bind_by_credentials'],
  } }))
  let attempts = 0
  await page.route('**/api/auth/device-login/bind-by-credentials', async route => {
    attempts++
    expect(route.request().postDataJSON()).toEqual({
      ...devicePayload, identifier: '5551234567', password: attempts === 1 ? 'wrong' : 'correct',
    })
    await route.fulfill(attempts === 1
      ? { status: 401, json: { error: 'Invalid credentials' } }
      : { json: session })
  })
  await open(page)
  await page.getByRole('button', { name: 'Sign in with WeChat' }).click()
  const modal = page.getByRole('dialog')
  await modal.getByRole('button', { name: 'Link an existing account' }).click()
  await modal.getByPlaceholder('Username or phone number').fill('5551234567')
  await modal.getByPlaceholder('Password', { exact: true }).fill('wrong')
  await modal.getByRole('button', { name: 'Confirm' }).click()
  await expect(modal.getByText('Invalid username or password')).toBeVisible()
  await modal.getByPlaceholder('Password', { exact: true }).fill('correct')
  await modal.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByRole('heading', { name: 'Signed in' })).toBeVisible()
  expect(attempts).toBe(2)
})

test('account settings verifies the password before unlinking, retaining the session', async ({ page }) => {
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: account } }))
  let attempts = 0
  await page.route('**/api/auth/device-binding', async route => {
    attempts++
    expect(route.request().method()).toBe('DELETE')
    expect(route.request().headers().authorization).toBe('Bearer ' + token)
    expect(route.request().postDataJSON()).toEqual({ currentPassword: attempts === 1 ? 'wrong' : 'correct' })
    await route.fulfill(attempts === 1
      ? { status: 401, json: { error: 'Invalid credentials' } }
      : { json: { success: true, hadBinding: true } })
  })
  await open(page, '#/hermes/settings', true)
  await page.getByRole('button', { name: 'Unlink WeChat' }).click()
  const modal = page.getByRole('dialog')
  await modal.getByPlaceholder('Current Password').fill('wrong')
  await modal.getByRole('button', { name: 'Confirm' }).click()
  await expect(modal.getByText('Invalid username or password')).toBeVisible()
  await modal.getByPlaceholder('Current Password').fill('correct')
  await modal.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByText('No WeChat account linked')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('hermes_api_key'))).toBe(token)
  expect(attempts).toBe(2)
})

test('closing a pending QR attempt prevents a late approval from signing in', async ({ page }) => {
  await mockApproval(page)
  let release: () => void = () => {}
  let requestSeen: () => void = () => {}
  const hold = new Promise<void>(resolve => { release = resolve })
  const seen = new Promise<void>(resolve => { requestSeen = resolve })
  let completed = false
  await page.route(platform + '/api/device-login/status?*', async route => {
    requestSeen()
    await hold
    await route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: { success: true, data: {
        status: 'approved', device: { device_id: 2 },
        api: { api_base: platform, api_key: apiKey, models: [] },
      } },
    }).catch(() => undefined)
  })
  await page.route('**/api/auth/device-login', route => {
    completed = true
    return route.fulfill({ json: session })
  })
  await open(page)
  await page.getByRole('button', { name: 'Sign in with WeChat' }).click()
  await seen
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).not.toBeVisible()
  release()
  await expect(page.getByRole('button', { name: 'Login', exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('hermes_api_key'))).toBeNull()
  expect(completed).toBe(false)
})

test('a QR request cannot redirect the scan to a different callback origin', async ({ page }) => {
  await page.route(platform + '/api/device-login/request', route => route.fulfill({
    headers: { 'access-control-allow-origin': '*' },
    json: { success: true, data: {
      login_id: 'scan-2', appid: 'wx-example', state: 'state-2', redirect_uri: 'https://elsewhere.example.test/callback',
    } },
  }))
  await open(page)
  await page.getByRole('button', { name: 'Sign in with WeChat' }).click()
  await expect(page.getByText('Failed to load QR code')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open WeChat Login Page' })).toHaveCount(0)
})
