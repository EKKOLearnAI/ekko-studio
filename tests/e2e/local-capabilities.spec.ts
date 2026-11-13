import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

async function open(page: Page, path = '/hermes/client-plugins', surface = '') {
  await page.addInitScript(() => {
    ;(window as any).__APP_VERSION__ = 'test'
    if (!localStorage.getItem('hermes_api_key')) localStorage.setItem('hermes_api_key', `test.${btoa(JSON.stringify({ sub: '1', role: 'super_admin' }))}.fixture`)
    localStorage.setItem('hermes_locale', 'en')
    localStorage.setItem('hermes_active_profile_name', 'default')
  })
  await page.route(/socket__io-client.*\.js/, route => route.fulfill({ contentType: 'text/javascript', body: `export function io(){ const s={connected:true,on(){return s},off(){return s},disconnect(){},emit(name,payload,ack){if(typeof ack==='function')ack({ok:true,data:{devices:[],events:[],runtime:{enabled:true,state:'running',updatedAt:'2026-11-13'}}})}};return s }` }))
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/hermes/profiles') return route.fulfill({ json: { profiles: [{ name: 'default', alias: 'Default', active: true, model: 'test' }] } })
    if (path === '/api/hermes/providers') return route.fulfill({ json: { providers: [] } })
    if (path === '/api/studio/meeting-storage') return route.fulfill({ json: { meetings: [] } })
    if (path === '/api/studio/meeting-asr/status') return route.fulfill({ json: { isRunning: false, asrPort: null, diarizePort: null, error: null } })
    if (path === '/api/studio/meeting-asr/start') return route.fulfill({ json: { status: 'started', asrPort: 8000 } })
    if (path === '/api/studio/meeting-asr/healthz') return route.fulfill({ json: { status: 'ok' } })
    if (path === '/api/studio/usb/devices') return route.fulfill({ json: { devices: [], runtime: { state: 'running', enabled: true } } })
    if (path === '/api/studio/usb/history') return route.fulfill({ json: { events: [] } })
    if (path === '/api/studio/devices') return route.fulfill({ json: { scanning: false, devices: [], requests: [], last_scanned_at: null } })
    if (path === '/api/studio/xiaozhi/status') return route.fulfill({ json: { configured: false, gatewayOnline: false, sessions: 0 } })
    if (path.endsWith('/discussion')) return route.fulfill({ json: { discussion: null } })
    if (path.endsWith('/documents')) return route.fulfill({ json: { documents: [] } })
    if (path === '/api/studio/knowledge/vaults') return route.fulfill({ json: { vaults: [] } })
    if (path === '/api/studio/knowledge/documents') return route.fulfill({ json: { documents: [] } })
    if (path === '/api/studio/knowledge/health') return route.fulfill({ json: { totalVaults: 0, totalDocuments: 0, indexedDocuments: 0 } })
    if (path.endsWith('/settings')) return route.fulfill({ json: { setting: null, providers: [], settings: {} } })
    if (path.endsWith('/events')) return route.fulfill({ json: { events: [], cursor: 0 } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/local-capabilities.ts').replace(/^\//, '')
  await page.route(url => url.pathname === '/__local_capabilities__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto(`/__local_capabilities__${surface ? '?surface=' + surface : ''}#${path}`)
}

test('local plugins start disabled, persist explicit choices, and preserve Scanner dependency', async ({ page }) => {
  await open(page)
  const cards = page.locator('.plugin-card')
  await expect(cards).toHaveCount(3)
  await expect(cards.getByRole('switch', { checked: true })).toHaveCount(0)
  const scanner = cards.filter({ has: page.locator('.plugin-card-id', { hasText: /^scanner$/ }) }).getByRole('switch')
  const grading = cards.filter({ has: page.locator('.plugin-card-id', { hasText: /^paper-grading$/ }) }).getByRole('switch')
  await expect(grading).toBeDisabled()
  await scanner.click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('hermes.plugins.enabled') || '{}').scanner)).toBe(true)
  await expect(grading).toBeEnabled()
  await grading.click()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('hermes.plugins.enabled') || '{}')['paper-grading'])).toBe(true)
  await page.reload()
  await expect(cards.getByRole('switch', { checked: true })).toHaveCount(2)
  await scanner.click()
  await expect(grading).not.toBeChecked()
  await expect(grading).toBeDisabled()
})

test('meeting, USB and LAN/Xiaozhi screens remain reachable on the migrated client', async ({ page }) => {
  await open(page, '/hermes/meeting')
  await expect(page.locator('.meeting-view')).toBeVisible()
  await page.goto('/__local_capabilities__#/hermes/usb')
  await expect(page.getByRole('heading', { name: 'USB Devices', exact: true })).toBeVisible()
  await expect(page.getByText('No USB storage devices are currently available.')).toBeVisible()
  await page.goto('/__local_capabilities__#/hermes/devices')
  await expect(page.getByRole('heading', { name: 'Device connection · XiaoZhi' })).toBeVisible()
  await expect(page.getByText('No devices found')).toBeVisible()
})

test('meeting recording loads the static worklet and sends authenticated 16 kHz PCM', async ({ page }) => {
  const binaryFrames: Buffer[] = []
  let authenticated = false
  await page.routeWebSocket(url => url.pathname === '/ws/asr', ws => {
    authenticated = !!new URL(ws.url()).searchParams.get('token')
    ws.onMessage(data => { if (Buffer.isBuffer(data)) binaryFrames.push(data) })
  })
  await page.addInitScript(() => {
    localStorage.setItem('hermes.meeting.asrConfig', JSON.stringify({ dashscopeApiKey: 'fixture-only' }))
    Object.defineProperty(navigator, 'mediaDevices', { value: {
      enumerateDevices: async () => [{ kind: 'audioinput' }],
      getUserMedia: async () => new MediaStream(),
    } })
    class TestAudioContext {
      sampleRate = 48000
      audioWorklet = { addModule: async (path: string) => {
        const response = await fetch(path)
        if (!response.ok) throw new Error('Worklet request failed')
      } }
      createMediaStreamSource() { return { connect() {} } }
      createAnalyser() { return { frequencyBinCount: 128, connect() {}, getByteFrequencyData() {} } }
      async close() {}
    }
    Object.defineProperty(window, 'AudioContext', { value: TestAudioContext })
    Object.defineProperty(window, 'AudioWorkletNode', { value: class {
      port: { onmessage?: (event: unknown) => void } = {}
      constructor() {
        Object.defineProperty(window, 'emitTestAudio', { value: () => {
          this.port.onmessage?.({ data: { samples: new Float32Array(480).fill(0.5), sourceSampleRate: 48000 } })
        } })
      }
    } })
    Object.defineProperty(window, 'MediaRecorder', { value: class {
      state = 'inactive'
      start() { this.state = 'recording' }
      stop() { this.state = 'inactive' }
    } })
  })

  await open(page, '/hermes/meeting')
  await page.getByRole('button', { name: 'New Meeting', exact: true }).click()
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const worklet = page.waitForResponse(response => new URL(response.url()).pathname === '/audio/pcm-worklet.js')
  await page.getByRole('button', { name: 'Start Recording', exact: true }).click()
  expect((await worklet).ok()).toBe(true)
  await expect(page.getByRole('button', { name: 'Stop Recording', exact: true })).toBeVisible()
  await page.evaluate(() => (window as Window & { emitTestAudio?: () => void }).emitTestAudio?.())
  await expect.poll(() => binaryFrames.map(frame => frame.length)).toEqual([320])
  expect(binaryFrames[0].readInt16LE(0)).toBe(16383)
  expect(authenticated).toBe(true)
})

test('enabled scanner, grading and knowledge pages load with upstream locale messages', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('hermes.plugins.enabled', JSON.stringify({ scanner: true, 'paper-grading': true, knowledge: true })))
  await open(page, '/hermes/scanner')
  await expect(page.locator('.scanner-view')).toBeVisible()
  await page.goto('/__local_capabilities__#/hermes/grading-batch')
  await expect(page.locator('.grading-view')).toBeVisible()
  await page.goto('/__local_capabilities__#/hermes/knowledge')
  await expect(page.locator('.knowledge-view')).toBeVisible()
})


test('Qwen realtime and speech practice setup remain available beside upstream voice', async ({ page }) => {
  await open(page, '/hermes/client-plugins', 'practice')
  const practice = page.getByRole('dialog')
  await expect(practice).toContainText('Practice language')
  await expect(practice.getByRole('button', { name: 'Start practice', exact: true })).toBeVisible()
  await open(page, '/hermes/client-plugins', 'omni')
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('dialog')).not.toContainText('Practice language')
})

test('group discussion and document controls use the restored Studio APIs', async ({ page }) => {
  await open(page, '/hermes/client-plugins', 'discussion')
  await expect(page.getByText('Free Discussion', { exact: true })).toBeVisible()
  await expect(page.getByText('Document Pipeline', { exact: true })).toBeVisible()
  await page.getByPlaceholder('Describe the problem you want the agents in the room to discuss and solve…').fill('Compare the two plans')
  await expect(page.getByRole('button', { name: 'Start Free Discussion', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Upload Document', exact: true })).toBeVisible()
})
