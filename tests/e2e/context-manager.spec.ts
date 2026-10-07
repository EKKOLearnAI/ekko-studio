import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page, type Route } from '@playwright/test'
import type { ContextManagerHealth, ContextManagerSettings } from '../../packages/client/src/api/studio/context-manager'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const url = '/#/hermes/settings?tab=contextManager'
const screenshotDirectory = join(process.env.PLAYWRIGHT_OUTPUT_DIR || 'test-results', 'screenshots')
const defaults: ContextManagerSettings = {
  hermes: { manager: 'native' }, ekko: { manager: 'native' },
  proxyUrl: 'http://127.0.0.1:8787', allowNativeFallback: false,
}
type Profile = 'default' | 'research'
type RecordedRequest = { method: string; pathname: string; profile: string; body: unknown }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function setup(page: Page) {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  const state = {
    settings: { default: structuredClone(defaults), research: structuredClone(defaults) },
    requests: [] as RecordedRequest[],
    installed: true,
    management: 'none' as ContextManagerHealth['lifecycle']['management'],
    healthy: false,
    compatibility: 'unverified' as ContextManagerHealth['compatibility'],
    settingsFail: false,
    healthFail: false,
    workerStatus: 'unknown' as ContextManagerHealth['worker']['status'],
    workerPids: [100],
    activeSessions: 2,
    runningSessions: 0,
    compatibilityIssues: [] as string[],
    observationError: false,
    saveGate: null as ReturnType<typeof deferred> | null,
    healthGate: null as ReturnType<typeof deferred> | null,
  }
  await page.route('**/api/studio/context-manager/**', async (route: Route) => {
    const request = route.request()
    const profile = request.headers()['x-hermes-profile']
    expect(['default', 'research']).toContain(profile)
    const name = profile as Profile
    const pathname = new URL(request.url()).pathname
    const body = request.postData() ? request.postDataJSON() : null
    state.requests.push({ method: request.method(), pathname, profile, body })
    if (pathname.endsWith('/settings')) {
      if (state.settingsFail) {
        await route.fulfill({ status: 503, json: { error: 'Settings unavailable in local test' } })
        return
      }
      if (request.method() === 'PUT') {
        state.settings[name] = structuredClone(body)
        await state.saveGate?.promise
      }
      await route.fulfill({ json: state.settings[name] })
      return
    }
    if (pathname.endsWith('/health')) {
      const health: ContextManagerHealth = {
        profile, settings: structuredClone(state.settings[name]), healthy: state.healthy,
        observations: {
          manifest: { endpoint: '/api/manifest', available: state.healthy, statusCode: state.healthy ? 200 : null },
          status: { endpoint: '/api/status', available: state.healthy, statusCode: state.healthy ? 200 : 503,
            ...(state.observationError ? { errorCode: 'context_manager_probe_http', error: 'token=private-token at /private/.env' } : {}) },
        },
        compatibility: state.compatibility, compatibilityIssues: state.compatibilityIssues,
        runtimeVersion: state.healthy ? '0.1.182' : null, worker: { profile, status: state.workerStatus,
          pids: state.workerStatus === 'running' ? [...state.workerPids] : [], activeSessions: state.workerStatus === 'unknown' ? null : state.activeSessions,
          runningSessions: state.workerStatus === 'unknown' ? null : state.runningSessions },
        lifecycle: {
          supported: true, installed: state.installed, version: state.installed ? '0.1.181' : null,
          running: state.management !== 'none', management: state.management,
          runtimeOrigin: state.management === 'none' ? null : state.settings[name].proxyUrl,
          configFile: '/local-test/config.json',
        },
      }
      await state.healthGate?.promise
      await route.fulfill(state.healthFail
        ? { status: 503, json: { error: 'Health unavailable in local test' } }
        : { json: health })
      return
    }
    if (pathname.endsWith('/worker/restart')) {
      if (body.profile !== name || body.confirm !== true) {
        await route.fulfill({ status: 409, json: { code: 'context_manager_profile_changed', error: 'Selected profile changed' } })
      } else if (state.runningSessions > 0) {
        await route.fulfill({ status: 409, json: { code: 'context_manager_sessions_running', error: 'token=private-token at /private/.env' } })
      } else {
        state.workerPids = [200]
        state.activeSessions = 0
        await route.fulfill({ json: { profile, status: 'restarted' } })
      }
      return
    }
    const action = pathname.split('/').at(-1)
    expect(request.method()).toBe('POST')
    expect(body).toEqual({ manager: 'hermes' })
    if (action === 'install') state.installed = true
    if (action === 'start') state.management = 'studio'
    if (action === 'stop') state.management = 'none'
    await route.fulfill({ json: { manager: 'hermes', action, status: `${action}ed` } })
  })
  return { state, api }
}

async function navigate(page: Page, reload = false) {
  if (reload) await page.reload()
  else await page.goto(url)
  // The parent loading surface also waits for the general settings request.
  await expect(page.locator('.settings-view')).toHaveAttribute('aria-busy', 'false', { timeout: 20_000 })
}
function panel(page: Page) { return page.locator('.context-manager-settings') }
function row(page: Page, label: string) {
  return panel(page).locator('.setting-row').filter({ has: page.locator('.setting-label', { hasText: new RegExp(`^${label}$`) }) })
}
async function choose(page: Page, agent: string, backend: 'Built-in' | 'Billion Context') {
  await row(page, agent).locator('.n-base-selection').click()
  await page.locator('.n-base-select-menu:visible .n-base-select-option').filter({ hasText: new RegExp(`^${backend}$`) }).click()
  await expect(page.locator('.n-base-select-menu:visible')).toHaveCount(0)
}
async function loaded(page: Page) {
  await expect(page.locator('.n-tabs-tab--active')).toHaveText('Context Management')
  await expect(panel(page).locator('[data-action="save"]')).toBeEnabled()
  await expect(row(page, 'Hermes')).toContainText('Built-in')
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => ({
    document: document.documentElement.scrollWidth <= window.innerWidth,
    body: document.body.scrollWidth <= window.innerWidth,
    panel: (() => { const element = document.querySelector('.context-manager-settings')!; return element.scrollWidth <= element.clientWidth })(),
  }))).toEqual({ document: true, body: true, panel: true })
  for (const element of await panel(page).locator('.n-base-selection, input, button').all()) {
    const box = await element.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  }
}
async function screenshot(page: Page, name: string) {
  await mkdir(screenshotDirectory, { recursive: true })
  const path = join(screenshotDirectory, `${name}.png`)
  await page.screenshot({ path, fullPage: true, animations: 'disabled' })
  console.log(`Screenshot: ${path}`)
}
async function disabledActions(page: Page, actions: string[]) {
  for (const action of actions) await expect(panel(page).locator(`[data-action="${action}"]`)).toBeDisabled()
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px context management`, () => {
    const consoleErrors = new WeakMap<Page, string[]>()
    const pageErrors = new WeakMap<Page, string[]>()
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport)
      consoleErrors.set(page, [])
      pageErrors.set(page, [])
      page.on('console', message => { if (message.type() === 'error') consoleErrors.get(page)!.push(message.text()) })
      page.on('pageerror', error => pageErrors.get(page)!.push(error.message))
    })
    test.afterEach(async ({ page }, testInfo) => {
      const errors = { consoleErrors: consoleErrors.get(page), pageErrors: pageErrors.get(page) }
      await testInfo.attach('browser-errors', { body: JSON.stringify(errors, null, 2), contentType: 'application/json' })
      console.log(`Browser errors: ${JSON.stringify(errors)}`)
      expect(errors.pageErrors).toEqual([])
      expect(errors.consoleErrors!.filter(error => !error.includes('503 (Service Unavailable)') && !error.includes('409 (Conflict)'))).toEqual([])
    })

    test('saves independent Hermes and Ekko selections and reloads with fallback off', async ({ page }) => {
      // Three Vite document loads must fit alongside both complete save flows.
      test.setTimeout(60_000)
      const { state, api } = await setup(page)
      await navigate(page)
      await loaded(page)
      await expect(row(page, 'Ekko')).toContainText('Built-in')
      await expect(panel(page).getByRole('switch')).not.toBeChecked()
      await expect(row(page, 'Worker Status')).toContainText('Unknown')
      await expect(row(page, 'Health')).toContainText('Unavailable')
      await expect(row(page, 'Compatibility')).toContainText('Unverified')
      await noOverflow(page)
      await screenshot(page, `defaults-${viewport.width}`)
      await choose(page, 'Hermes', 'Billion Context')
      await expect(row(page, 'Ekko')).toContainText('Built-in')
      await panel(page).locator('[data-action="save"]').click()
      await expect(panel(page).locator('[data-action="save"]')).toBeEnabled()
      expect(state.requests.filter(request => request.method === 'PUT')).toEqual([
        { method: 'PUT', pathname: '/api/studio/context-manager/settings', profile: 'research', body: { ...defaults, hermes: { manager: 'bili' } } },
      ])
      await navigate(page, true)
      await expect(row(page, 'Hermes')).toContainText('Billion Context')
      await expect(row(page, 'Ekko')).toContainText('Built-in')
      await expect(panel(page).getByRole('switch')).not.toBeChecked()
      await choose(page, 'Hermes', 'Built-in')
      await choose(page, 'Ekko', 'Billion Context')
      await panel(page).getByRole('switch').click()
      await panel(page).locator('[data-action="save"]').click()
      await expect(panel(page).locator('[data-action="save"]')).toBeEnabled()
      expect(state.requests.filter(request => request.method === 'PUT').at(-1)?.body).toEqual({ ...defaults, ekko: { manager: 'bili' }, allowNativeFallback: true })
      expect(state.settings.default).toEqual(defaults)
      await navigate(page, true)
      await loaded(page)
      await expect(row(page, 'Ekko')).toContainText('Billion Context')
      await expect(panel(page).getByRole('switch')).toBeChecked()
      await noOverflow(page)
      await screenshot(page, `saved-${viewport.width}`)
      expect(api.unexpectedRequests).toEqual([])
      expect(state.requests.every(request => request.profile === 'research')).toBe(true)
    })

    test('dispatches install, start, stop and upgrade to the selected profile', async ({ page }) => {
      const { state, api } = await setup(page)
      state.installed = false
      await navigate(page)
      await loaded(page)
      for (const action of ['install', 'start', 'stop', 'upgrade']) {
        const button = panel(page).locator(`[data-action="${action}"]`)
        await expect(button).toBeEnabled()
        await button.click()
        await expect(panel(page).locator('[data-action="refresh"]')).toBeEnabled()
      }
      expect(state.requests.filter(request => request.method === 'POST')).toEqual(
        ['install', 'start', 'stop', 'upgrade'].map(action => ({ method: 'POST', pathname: `/api/studio/context-manager/lifecycle/${action}`, profile: 'research', body: { manager: 'hermes' } })),
      )
      await expect(row(page, 'Process Management')).toContainText('Not running')
      expect(api.unexpectedRequests).toEqual([])
    })

    test('never enables stop or upgrade for an external runtime', async ({ page }) => {
      const { state, api } = await setup(page)
      state.management = 'external'
      state.healthy = true
      state.compatibility = 'compatible'
      await navigate(page)
      await loaded(page)
      await expect(row(page, 'Process Management')).toContainText('Externally managed')
      await expect(row(page, 'Worker Status')).toContainText('Unknown')
      await disabledActions(page, ['install', 'start', 'stop', 'upgrade'])
      await noOverflow(page)
      await screenshot(page, `external-${viewport.width}`)
      expect(state.requests.filter(request => request.method === 'POST')).toEqual([])
      expect(api.unexpectedRequests).toEqual([])
    })

    test('clears stale positive health while refreshing and after a failed check', async ({ page }) => {
      const { state, api } = await setup(page)
      state.healthy = true
      state.compatibility = 'compatible'
      await navigate(page)
      await loaded(page)
      await expect(row(page, 'Health')).toContainText('Healthy')
      state.healthGate = deferred()
      state.healthFail = true
      await panel(page).locator('[data-action="refresh"]').click()
      try {
        await expect(panel(page).getByText('Healthy', { exact: true })).toHaveCount(0)
        await expect(panel(page).getByText('Compatible', { exact: true })).toHaveCount(0)
        await disabledActions(page, ['install', 'start', 'stop', 'upgrade'])
      } finally { state.healthGate.resolve() }
      await expect(panel(page).getByText('Could not check proxy status', { exact: true })).toBeVisible()
      await expect(panel(page).getByText('Healthy', { exact: true })).toHaveCount(0)
      await disabledActions(page, ['install', 'start', 'stop', 'upgrade'])
      await noOverflow(page)
      await screenshot(page, `health-failed-${viewport.width}`)
      expect(api.unexpectedRequests).toEqual([])
    })

    test('keeps save disabled when settings fail to load', async ({ page }) => {
      const { state, api } = await setup(page)
      state.settingsFail = true
      await navigate(page)
      await expect(panel(page).getByText('Could not load settings', { exact: true }).first()).toBeVisible()
      await expect(panel(page).locator('[data-action="save"]')).toBeDisabled()
      await expect(panel(page).locator('.n-select')).toHaveCount(0)
      await noOverflow(page)
      await screenshot(page, `load-failed-${viewport.width}`)
      expect(state.requests.filter(request => request.method === 'PUT')).toEqual([])
      expect(api.unexpectedRequests).toEqual([])
    })

    test('confirms session impact and reads replacement worker state without touching an external proxy', async ({ page }) => {
      const { state, api } = await setup(page)
      state.management = 'external'
      state.workerStatus = 'running'
      state.healthy = true
      state.compatibility = 'incompatible'
      state.compatibilityIssues = ['fork']
      await navigate(page)
      await loaded(page)
      await expect(row(page, 'Compatibility')).toContainText('Incompatible')
      await expect(panel(page).locator('[data-error="compatibility"]')).toContainText('does not support conversation forks')
      await disabledActions(page, ['stop', 'upgrade'])
      await panel(page).locator('[data-action="restart-worker"]').click()
      await expect(panel(page).getByRole('dialog')).toContainText('profile research')
      await expect(panel(page).getByRole('dialog')).toContainText('2 loaded sessions')
      expect(state.requests.filter(request => request.method === 'POST')).toEqual([])
      await noOverflow(page)
      await screenshot(page, `worker-confirmation-${viewport.width}`)
      await panel(page).locator('[data-action="confirm-restart"]').click()
      await expect(panel(page).locator('[data-worker-pids]')).toHaveText('200')
      await expect(row(page, 'Loaded Sessions')).toContainText('0')
      expect(state.requests.filter(request => request.method === 'POST')).toEqual([
        { method: 'POST', pathname: '/api/studio/context-manager/worker/restart', profile: 'research', body: { profile: 'research', confirm: true } },
      ])
      expect(state.management).toBe('external')
      expect(state.requests.filter(request => request.pathname.endsWith('/health'))).toHaveLength(2)
      expect(api.unexpectedRequests).toEqual([])
    })

    test('refuses sessions that start after confirmation and renders safe localized errors', async ({ page }) => {
      const { state } = await setup(page)
      state.workerStatus = 'running'
      state.observationError = true
      await navigate(page)
      await loaded(page)
      await expect(panel(page).locator('[data-error="health"]')).toContainText('context_manager_probe_http')
      await panel(page).locator('[data-action="restart-worker"]').click()
      state.runningSessions = 1
      await panel(page).locator('[data-action="confirm-restart"]').click()
      await expect(panel(page).locator('[data-error="operation"]')).toContainText('context_manager_sessions_running')
      await expect(panel(page).locator('[data-error="operation"]')).toContainText('Wait for running sessions')
      await expect(panel(page)).not.toContainText('private-token')
      await expect(panel(page)).not.toContainText('/private/.env')
      expect(state.workerPids).toEqual([100])
      await panel(page).locator('[data-action="refresh"]').click()
      await expect(panel(page).locator('[data-action="restart-worker"]')).toBeDisabled()
      await noOverflow(page)
      await screenshot(page, `worker-refused-${viewport.width}`)
    })

    test('cancels worker confirmation when the selected profile changes', async ({ page }) => {
      const { state } = await setup(page)
      state.workerStatus = 'running'
      await navigate(page)
      await loaded(page)
      await panel(page).locator('[data-action="restart-worker"]').click()
      await expect(panel(page).getByRole('dialog')).toBeVisible()
      await page.evaluate(async () => {
        const source = '/src/stores/hermes/profiles.ts'
        const { useProfilesStore } = await import(source)
        await useProfilesStore().switchProfile('default')
      })
      await expect(panel(page).getByRole('dialog')).toHaveCount(0)
      expect(state.requests.filter(request => request.method === 'POST')).toEqual([])
      await noOverflow(page)
    })

    test('ignores a pending save after an in-place profile change', async ({ page }) => {
      const { state, api } = await setup(page)
      state.settings.default.ekko.manager = 'bili'
      await navigate(page)
      await loaded(page)
      await choose(page, 'Hermes', 'Billion Context')
      state.saveGate = deferred()
      await panel(page).locator('[data-action="save"]').click()
      await expect.poll(() => state.requests.filter(request => request.method === 'PUT').length).toBe(1)
      // The sidebar reloads the document; use the real store/API to exercise the
      // component's in-place generation guard without destroying its pending save.
      await page.evaluate(async () => {
        const source = '/src/stores/hermes/profiles.ts'
        const { useProfilesStore } = await import(source)
        await useProfilesStore().switchProfile('default')
      })
      await expect(row(page, 'Hermes')).toContainText('Built-in')
      await expect(row(page, 'Ekko')).toContainText('Billion Context')
      const oldSave = page.waitForResponse(response => response.url().endsWith('/context-manager/settings') && response.request().method() === 'PUT')
      state.saveGate.resolve()
      await oldSave
      await expect(panel(page).locator('[data-action="save"]')).toBeEnabled()
      await expect(row(page, 'Hermes')).toContainText('Built-in')
      await expect(row(page, 'Ekko')).toContainText('Billion Context')
      await expect(page.getByText('Settings saved', { exact: true })).toHaveCount(0)
      await expect(panel(page).getByRole('switch')).not.toBeChecked()
      expect(state.requests.filter(request => request.method === 'PUT')[0].profile).toBe('research')
      expect(state.requests.filter(request => request.pathname.endsWith('/health') && request.profile === 'research')).toHaveLength(1)
      await noOverflow(page)
      expect(api.unexpectedRequests).toEqual([])
    })
  })
}