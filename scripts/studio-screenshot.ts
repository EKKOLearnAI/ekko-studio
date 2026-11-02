import { mkdir, readFile, writeFile, chmod, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium, request, type APIRequestContext, type BrowserContext } from '@playwright/test'
import type { ViteDevServer } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const presets: Record<string, { route: string; ready: string }> = {
  chat: { route: '/hermes/chat', ready: '.chat-view' },
  person: { route: '/person', ready: '.person-view' },
  workflow: { route: '/hermes/workflow', ready: '.workflow-view' },
  models: { route: '/hermes/models', ready: '.chat-view' },
  history: { route: '/hermes/history', ready: '.history-panel' },
  usage: { route: '/hermes/usage', ready: '.usage-view' },
  settings: { route: '/hermes/settings', ready: '.settings-view' },
}

const help = `Studio screenshots (Playwright)

  npm run screenshot -- --mock
  npm run screenshot -- --base-url http://127.0.0.1:8649 --pages chat,person
  npm run screenshot -- --mock --route '/hermes/models?tab=api' --viewport 390x844

Options:
  --mock                 Start current frontend with isolated E2E mock data
  --base-url URL         Running Studio URL (default: http://127.0.0.1:8649)
  --pages LIST           chat,person,workflow,models (default); also history,usage,settings,all
  --route PATH           Custom hash-router path; repeat for multiple pages
  --viewport WIDTHxHEIGHT  Default: 1440x1000
  --out DIRECTORY        Default: test-results/studio-screenshots/<timestamp>
  --auth-state FILE      Reuse/save real login (default: .playwright/studio-auth.json)
  --locale zh|en         UI language (default: zh)
  --profile NAME         Select a Hermes profile in this browser only
  --full-page            Capture the document beyond the viewport
  --selector CSS         Capture one element instead of the page
  --wait-for CSS         Wait for a visible element before each capture
  --timeout MS           Page/auth timeout (default: 45000)
  --headed               Show the browser window
  --channel NAME         System browser, e.g. chrome (or PLAYWRIGHT_CHANNEL)
  --help                 Show this help

Real login: set STUDIO_SCREENSHOT_TOKEN, or both STUDIO_SCREENSHOT_USERNAME and
STUDIO_SCREENSHOT_PASSWORD once. Later runs reuse --auth-state. Mock mode never
loads or saves real login state. Credentials are never written to the manifest.
`

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>
export interface Credentials { token?: string; username?: string; password?: string }

export function parseScreenshotOptions(args: string[]) {
  const { values } = parseArgs({ args, options: {
    mock: { type: 'boolean' }, 'base-url': { type: 'string' }, pages: { type: 'string' },
    route: { type: 'string', multiple: true }, viewport: { type: 'string', default: '1440x1000' },
    out: { type: 'string' }, 'auth-state': { type: 'string' }, locale: { type: 'string', default: 'zh' },
    profile: { type: 'string' }, 'full-page': { type: 'boolean' }, selector: { type: 'string' },
    'wait-for': { type: 'string' }, timeout: { type: 'string', default: '45000' },
    headed: { type: 'boolean' }, channel: { type: 'string' }, help: { type: 'boolean' },
  } })
  if (values.help) return { help: true as const }
  const dimensions = /^(\d+)x(\d+)$/.exec(values.viewport!)
  if (!dimensions || dimensions.slice(1).some(value => +value < 1 || +value > 8192)) {
    throw new Error('--viewport must be WIDTHxHEIGHT, with dimensions from 1 to 8192')
  }
  const timeout = Number(values.timeout)
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('--timeout must be a positive integer')
  if (!['zh', 'en'].includes(values.locale!)) throw new Error('--locale must be zh or en')
  if (values.mock && (values['base-url'] || values['auth-state'])) {
    throw new Error('--mock starts an isolated frontend; do not combine it with --base-url or --auth-state')
  }
  if (values.selector && values['full-page']) throw new Error('--selector and --full-page cannot be combined')
  const base = new URL(values['base-url'] || 'http://127.0.0.1:8649/')
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('--base-url must be an HTTP(S) URL without credentials, query or hash')
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  const names = values.pages === 'all' ? Object.keys(presets)
    : (values.pages ?? (values.route?.length ? '' : 'chat,person,workflow,models')).split(',').map(name => name.trim()).filter(Boolean)
  const targets = names.map(name => {
    if (!presets[name]) throw new Error(`Unknown page: ${name}. Use ${Object.keys(presets).join(',')}, or all`)
    return { name, ...presets[name] }
  })
  for (const route of values.route ?? []) {
    if (!route.startsWith('/') || route.startsWith('//') || route.includes('#') || route.includes('\\')) {
      throw new Error('--route must be a router path such as /hermes/chat, without a URL or hash')
    }
    targets.push({ name: route.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'page', route, ready: '#app > *' })
  }
  if (!targets.length) throw new Error('Select at least one page or route')
  return {
    help: false as const, mock: !!values.mock, baseUrl: base.href, targets,
    viewport: { width: +dimensions[1]!, height: +dimensions[2]! }, timeout,
    out: resolve(values.out || resolve(root, 'test-results/studio-screenshots', new Date().toISOString().replace(/[:.]/g, '-'))),
    authState: resolve(values['auth-state'] || resolve(root, '.playwright/studio-auth.json')),
    locale: values.locale!, profile: values.profile, fullPage: !!values['full-page'],
    selector: values.selector, waitFor: values['wait-for'], headed: !!values.headed,
    channel: values.channel || process.env.PLAYWRIGHT_CHANNEL,
  }
}

export function storedScreenshotToken(state: StorageState | undefined, baseUrl: string) {
  return state?.origins.find(item => item.origin === new URL(baseUrl).origin)
    ?.localStorage.find(item => item.name === 'hermes_api_key')?.value
}

export async function authenticateScreenshot(api: APIRequestContext, baseUrl: string, credentials: Credentials) {
  let token = credentials.token
  if (!token && (credentials.username || credentials.password)) {
    if (!credentials.username || !credentials.password) throw new Error('Set both STUDIO_SCREENSHOT_USERNAME and STUDIO_SCREENSHOT_PASSWORD')
    const response = await api.post(new URL('api/auth/login', baseUrl).href, {
      data: { username: credentials.username, password: credentials.password }, maxRedirects: 0,
    })
    if (!response.ok()) throw new Error(`Studio login failed (HTTP ${response.status()})`)
    const body = await response.json().catch(() => null)
    if (typeof body?.token !== 'string' || !body.token) throw new Error('Studio login did not return a token')
    token = body.token
  }
  if (!token) throw new Error('No Studio login. Set STUDIO_SCREENSHOT_TOKEN, or STUDIO_SCREENSHOT_USERNAME and STUDIO_SCREENSHOT_PASSWORD; see --help')
  const response = await api.get(new URL('api/auth/me', baseUrl).href, {
    headers: { Authorization: `Bearer ${token}` }, maxRedirects: 0,
  })
  const body = response.ok() ? await response.json().catch(() => null) : null
  if (!body?.user?.id) throw new Error(`Studio login is invalid or expired (HTTP ${response.status()}); provide fresh credentials`)
  return token
}

async function installMockData(page: import('@playwright/test').Page) {
  const { authenticate, mockHermesApi } = await import('../tests/e2e/fixtures')
  await authenticate(page)
  const { unexpectedRequests } = await mockHermesApi(page, { initialProfileName: 'default', theme: { brightness: 'light' } })
  await page.route('**/api/studio/sessions/hermes/groups**', route => route.fulfill({ json: { groups: [], included: [] } }))
  await page.route('**/api/studio/models/api-keys', route => route.fulfill({ json: { keys: [] } }))
  await page.route('**/api/studio/models/cloud-link', route => route.fulfill({ json: { available: false, urls: null, reason: 'official_cloud_connection_required' } }))
  await page.route('**/api/ekko-studio/models/v1/models', route => route.fulfill({ json: { object: 'list', data: [
    { id: 'test-provider/test-model', owned_by: 'test-provider', api_mode: 'chat_completions', responses_supported: true },
  ] } }))
  const model = { profile: 'default', provider: 'test-provider', model: 'test-model' }
  await page.route('**/api/studio/person**', route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/conversations')) return route.fulfill({ json: { sessions: [], next_offset: null } })
    if (path.endsWith('/models') || path.endsWith('/agent-models')) {
      return route.fulfill({ json: { groups: [{ ...model, label: 'Screenshot fixture', models: ['test-model'] }] } })
    }
    if (path.endsWith('/capabilities')) return route.fulfill({ json: { agents: [], native_allowed: false } })
    if (path !== '/api/studio/person') return route.fallback()
    return route.fulfill({ json: {
      session: null, settings: { model, workspace: '', reasoningEffort: '', agents: [], timezone: 'Asia/Shanghai',
        compressionThreshold: null, maxSteps: 12, maxConcurrentTasks: 6, taskTimeoutMinutes: 60 },
      revision: 0, busy: false, history_revision: 0, can_clear: false, inherits_global_model: true,
      reasoning_efforts: [], compression: { enabled: true, threshold: 0.5, globalThreshold: 0.5 },
      contextTokens: 200000, tasks: [], schedules: [], memories: [], interactions: [],
    } })
  })
  return unexpectedRequests
}

async function saveLogin(context: BrowserContext, path: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // Tighten existing files before writing credentials as well as on creation.
  if (existsSync(path)) await chmod(path, 0o600)
  await writeFile(path, JSON.stringify(await context.storageState(), null, 2), { mode: 0o600 })
}

export async function runScreenshot(options: Exclude<ReturnType<typeof parseScreenshotOptions>, { help: true }>, credentials: Credentials = {}) {
  let server: ViteDevServer | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let api: APIRequestContext | undefined
  let screenshotCache: string | undefined
  try {
    let baseUrl = options.baseUrl
    let state: StorageState | undefined
    let token: string | undefined
    if (options.mock) {
      const { createServer } = await import('vite')
      await mkdir(resolve(root, 'node_modules/.vite'), { recursive: true })
      screenshotCache = await mkdtemp(resolve(root, 'node_modules/.vite/studio-screenshots-'))
      server = await createServer({
        configFile: resolve(root, 'vite.config.ts'), base: '/', logLevel: 'error',
        cacheDir: screenshotCache,
        server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
        // A missing fixture must never fall through to the user's running backend.
        plugins: [{ name: 'screenshot-isolation', configResolved(config) { config.server.proxy = undefined } }],
      })
      await server.listen()
      const address = server.httpServer?.address()
      if (!address || typeof address === 'string') throw new Error('Could not start the screenshot frontend')
      baseUrl = `http://127.0.0.1:${address.port}/`
    } else {
      if (existsSync(options.authState)) state = JSON.parse(await readFile(options.authState, 'utf8'))
      api = await request.newContext({ timeout: options.timeout })
      const suppliedCredentials = credentials.token || credentials.username || credentials.password
      token = await authenticateScreenshot(api, baseUrl, suppliedCredentials ? credentials : { token: storedScreenshotToken(state, baseUrl) })
    }
    browser = await chromium.launch({ headless: !options.headed, channel: options.channel })
    const context = await browser.newContext({
      viewport: options.viewport, locale: options.locale === 'zh' ? 'zh-CN' : 'en-US',
      reducedMotion: 'reduce', storageState: state,
    })
    context.setDefaultTimeout(options.timeout)
    context.setDefaultNavigationTimeout(options.timeout)
    await context.addInitScript(({ origin, token, locale, profile, baseUrl }) => {
      if (location.origin !== origin) return
      if (token) localStorage.setItem('hermes_api_key', token)
      localStorage.setItem('hermes_locale', locale)
      localStorage.setItem('hermes_server_url', baseUrl.replace(/\/$/, ''))
      if (profile) localStorage.setItem('hermes_active_profile_name', profile)
    }, { origin: new URL(baseUrl).origin, token, locale: options.locale, profile: options.profile, baseUrl })
    const manifest = {
      mode: options.mock ? 'mock' : 'live', baseUrl, viewport: options.viewport, locale: options.locale,
      createdAt: new Date().toISOString(), screenshots: [] as { route: string; path: string; title: string }[],
    }
    await mkdir(options.out, { recursive: true })
    for (const [index, target] of options.targets.entries()) {
      const path = resolve(options.out, `${String(index + 1).padStart(2, '0')}-${target.name}.png`)
      console.log(`Capturing ${target.route}`)
      const page = await context.newPage()
      try {
        const unexpectedRequests = options.mock ? await installMockData(page) : []
        await page.goto(`${baseUrl}#${target.route}`, { waitUntil: 'domcontentloaded' })
        await page.locator(target.ready).first().waitFor({ state: 'visible' })
        await page.waitForFunction(() => !document.querySelector('.page-loading[aria-busy="true"]'))
        if (new URL(page.url()).hash !== `#${target.route}`) {
          throw new Error(`Studio redirected away from ${target.route}; check login and page permissions`)
        }
        if (options.waitFor) await page.locator(options.waitFor).first().waitFor({ state: 'visible' })
        await page.waitForFunction(() => document.fonts.status === 'loaded')
        await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
        if (unexpectedRequests.length) {
          const missing = unexpectedRequests.map(item => `${item.method} ${item.pathname}`).join(', ')
          throw new Error(`Missing screenshot fixtures: ${missing}; add fixtures or use live mode`)
        }
        if (options.selector) await page.locator(options.selector).screenshot({ path, animations: 'disabled' })
        else await page.screenshot({ path, fullPage: options.fullPage, animations: 'disabled' })
        manifest.screenshots.push({ route: target.route, path, title: await page.title() })
        await writeFile(resolve(options.out, 'manifest.json'), JSON.stringify(manifest, null, 2))
        console.log(`Captured ${target.route}: ${path}`)
      } catch (error) {
        const diagnostic = path.replace(/\.png$/, '.failed.png')
        const captured = await page.screenshot({ path: diagnostic, timeout: 5000 }).then(() => true, () => false)
        const message = error instanceof Error ? error.message.split('\n')[0] : 'Capture failed'
        throw new Error(`${target.route}: ${message}${captured ? ` (diagnostic: ${diagnostic})` : ''}`)
      } finally {
        await page.close()
      }
    }
    if (!options.mock) await saveLogin(context, options.authState)
    return manifest
  } finally {
    await Promise.allSettled([browser?.close(), api?.dispose(), server?.close()])
    if (screenshotCache) await rm(screenshotCache, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseScreenshotOptions(process.argv.slice(2))
    if (options.help) console.log(help)
    else await runScreenshot(options, {
      token: process.env.STUDIO_SCREENSHOT_TOKEN,
      username: process.env.STUDIO_SCREENSHOT_USERNAME,
      password: process.env.STUDIO_SCREENSHOT_PASSWORD,
    })
  } catch (error) {
    // Avoid dumping Playwright request logs that can contain credential headers.
    const message = error instanceof Error ? error.message.split('\n')[0] : 'Screenshot failed'
    console.error(`Studio screenshot: ${message}`)
    process.exitCode = 1
  }
}
