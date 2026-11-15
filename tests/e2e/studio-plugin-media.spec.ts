import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { securityHeaders } from '../../packages/server/src/modules/studio/middleware/security'

test.use({ launchOptions: { args: ['--autoplay-policy=document-user-activation-required',
  '--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies'] } })

// A valid, silent one-second PCM WAV avoids providers, codecs and speaker output.
const wav = Buffer.alloc(44 + 16_000 * 2)
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
const audioData = `data:audio/wav;base64,${wav.toString('base64')}`
// Synthetic H.264 baseline/AAC clip: it has an audio track, so muted and audible
// autoplay exercise different policies without needing a remote provider.
const videoData = `data:video/mp4;base64,${readFileSync(resolve('tests/e2e/fixtures/plugin-video.mp4')).toString('base64')}`

async function mountPlugin(page: Page, source: string) {
  const headers: Record<string, string> = {}
  await securityHeaders()({ method: 'GET', path: '/', query: {}, secure: false,
    get: () => '', set: (name: string, value: string) => { headers[name] = value } } as any, async () => {})
  let clientRequests = 0, invokes = 0
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path.endsWith('/client')) { clientRequests++; return route.fulfill({ json: { source } }) }
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'media', events: [] } })
    if (path.endsWith('/invoke')) {
      expect(request.headers().authorization).toMatch(/^Bearer test\./)
      expect(request.headers()['x-hermes-profile']).toBe('default')
      invokes++
      return route.fulfill({ json: { result: 'authenticated bridge' } })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/plugin-media.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route(url => url.pathname === '/__plugin_media__', route => route.fulfill({ headers,
    contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  return { clientRequests: () => clientRequests, invokes: () => invokes }
}

function mediaSource() {
  return `export function mount(root) {
    const data = ${JSON.stringify(audioData)}, bytes = Uint8Array.from(atob(data.split(',')[1]), c => c.charCodeAt(0));
    const blob = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    for (const [id, src] of [['data', data], ['blob', blob]]) {
      const audio = document.createElement('audio'); audio.src = src; audio.controls = true; root.append(audio);
      const button = document.createElement('button'); button.textContent = 'Play ' + id; root.append(button);
      button.onclick = async () => { try { await audio.play(); root.dataset[id] = 'playing' }
        catch (error) { root.dataset[id] = error.name } };
    }
    return () => { for (const audio of root.querySelectorAll('audio')) audio.pause(); URL.revokeObjectURL(blob) };
  }`
}

test('opens a plugin on non-secure HTTP using a strong channel and keeps authenticated RPC working', async ({ page, baseURL }, testInfo) => {
  // Fulfill resources at a non-loopback origin so Chromium really disables secure-context APIs.
  // The application still loads the actual Vite-transformed component and its dependencies.
  const origin = 'http://studio-plugin.test'
  await page.route(url => url.origin === origin, async route => {
    const url = new URL(route.request().url())
    await route.fulfill({ response: await route.fetch({ url: `${baseURL}${url.pathname}${url.search}` }) })
  })
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const calls = await mountPlugin(page, `export function mount(root, ctx) {
    root.textContent = 'Mounted over HTTP';
    const button = document.createElement('button'); button.textContent = 'Call host'; root.append(button);
    button.onclick = async () => root.dataset.reply = await ctx.rpc.call('echo', {});
  }`)
  await page.goto(`${origin}/__plugin_media__`)
  const context = await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID, random: typeof crypto.getRandomValues }))
  await testInfo.attach('http-context', { body: JSON.stringify(context), contentType: 'application/json' })
  expect(context).toEqual({ secure: false, uuid: 'undefined', random: 'function' })
  const root = page.frameLocator('iframe').locator('#root')
  await expect(root).toContainText('Mounted over HTTP')
  await page.frameLocator('iframe').getByRole('button', { name: 'Call host' }).click()
  await expect(root).toHaveAttribute('data-reply', 'authenticated bridge')
  expect(calls.clientRequests()).toBeGreaterThan(0); expect(calls.invokes()).toBe(1)
  expect(errors).toEqual([])
})

test('plays inline and Blob audio on click with production CSP while retaining isolation for every plugin surface', async ({ page }) => {
  await mountPlugin(page, mediaSource())
  // Every supported page and the dynamic sidebar share PluginFrame's document and permissions.
  for (const slot of ['page', 'settings', 'workspace', 'agent-settings', 'workspace-sidebar']) {
    await page.goto(`/__plugin_media__?slot=${slot}`)
    const host = page.locator('iframe'), frame = page.frameLocator('iframe')
    await expect(host).toHaveAttribute('sandbox', 'allow-scripts')
    expect(await host.getAttribute('allow')).toBeNull()
    await frame.getByRole('button', { name: 'Play data' }).click()
    await expect(frame.locator('#root')).toHaveAttribute('data-data', 'playing')
    await expect.poll(() => frame.locator('audio').nth(0).evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0)
    await frame.getByRole('button', { name: 'Play blob' }).click()
    await expect(frame.locator('#root')).toHaveAttribute('data-blob', 'playing')
    await expect.poll(() => frame.locator('audio').nth(1).evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0)
    expect(await frame.locator('#root').evaluate(() => {
      try { return parent.localStorage.getItem('plugin-media-sentinel') } catch { return 'isolated' }
    })).toBe('isolated')
  }
})

test('continues to block network media and direct connections', async ({ page }) => {
  let remoteRequests = 0
  await page.route(url => url.hostname === 'media.invalid' || url.pathname === '/plugin-media-test.wav',
    route => { remoteRequests++; return route.abort() })
  await mountPlugin(page, `export async function mount(root) {
    document.addEventListener('securitypolicyviolation', event => {
      if (event.effectiveDirective === 'media-src') root.dataset.media = 'blocked';
      if (event.effectiveDirective === 'connect-src') root.dataset.connection = 'blocked';
    });
    // The host permits its own origin; the child must still reject that network media.
    for (const src of [new URL('/plugin-media-test.wav', document.baseURI).href, 'https://media.invalid/audio.wav']) {
      const audio = document.createElement('audio'); audio.src = src; root.append(audio); audio.load();
    }
    try { await fetch(${JSON.stringify(audioData)}) } catch { root.dataset.fetch = 'failed' }
  }`)
  await page.goto('/__plugin_media__')
  const root = page.frameLocator('iframe').locator('#root')
  await expect(root).toHaveAttribute('data-media', 'blocked')
  await expect(root).toHaveAttribute('data-connection', 'blocked')
  await expect(root).toHaveAttribute('data-fetch', 'failed')
  expect(remoteRequests).toBe(0)
})

test('handles the browser autoplay rejection separately from a successful user click', async ({ page }) => {
  await mountPlugin(page, `export function mount(root) {
    const audio = document.createElement('audio'); audio.src = ${JSON.stringify(audioData)}; root.append(audio);
    audio.play().then(() => root.dataset.auto = 'playing', error => root.dataset.auto = error.name);
    const button = document.createElement('button'); button.textContent = 'Enable sound'; root.append(button);
    button.onclick = async () => { await audio.play(); root.dataset.click = 'playing' };
    return () => audio.pause();
  }`)
  await page.goto('/__plugin_media__')
  const frame = page.frameLocator('iframe')
  await expect(frame.locator('#root')).toHaveAttribute('data-auto', 'NotAllowedError')
  await frame.getByRole('button', { name: 'Enable sound' }).click()
  await expect(frame.locator('#root')).toHaveAttribute('data-click', 'playing')
})

test('plays data and Blob video on click without adding iframe privileges', async ({ page }) => {
  await mountPlugin(page, `export function mount(root) {
    const data = ${JSON.stringify(videoData)}, bytes = Uint8Array.from(atob(data.split(',')[1]), c => c.charCodeAt(0));
    const blob = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
    for (const [id, src] of [['data', data], ['blob', blob]]) {
      const video = document.createElement('video'); video.id = id; video.src = src;
      video.controls = true; video.playsInline = true; video.width = 160; root.append(video);
      const button = document.createElement('button'); button.textContent = 'Play video ' + id; root.append(button);
      button.onclick = async () => { try { await video.play(); root.dataset[id] = 'playing' }
        catch (error) { root.dataset[id] = error.name } };
    }
    return () => { root.querySelectorAll('video').forEach(video => video.pause()); URL.revokeObjectURL(blob) };
  }`)
  await page.goto('/__plugin_media__')
  const frame = page.frameLocator('iframe')
  for (const id of ['data', 'blob']) {
    await frame.getByRole('button', { name: 'Play video ' + id }).click()
    await expect(frame.locator('#root')).toHaveAttribute('data-' + id, 'playing')
    await expect.poll(() => frame.locator('#' + id).evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0)
    expect(await frame.locator('#' + id).evaluate((video: HTMLVideoElement) => ({ width: video.videoWidth, height: video.videoHeight })))
      .toEqual({ width: 160, height: 90 })
  }
  await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
  expect(await page.locator('iframe').getAttribute('allow')).toBeNull()
})

test('allows muted inline video autoplay and provides a click fallback for audible video', async ({ page }) => {
  await mountPlugin(page, `export function mount(root) {
    for (const muted of [true, false]) {
      const id = muted ? 'muted' : 'audible', video = document.createElement('video');
      video.id = id; video.muted = muted; video.autoplay = true; video.playsInline = true;
      video.controls = true; video.width = 160; video.src = ${JSON.stringify(videoData)}; root.append(video);
      video.play().then(() => root.dataset[id] = 'playing', error => root.dataset[id] = error.name);
      if (!muted) {
        const button = document.createElement('button'); button.textContent = 'Play with sound'; root.append(button);
        button.onclick = async () => { await video.play(); root.dataset.click = 'playing' };
      }
    }
    return () => root.querySelectorAll('video').forEach(video => video.pause());
  }`)
  await page.goto('/__plugin_media__')
  const frame = page.frameLocator('iframe')
  await expect(frame.locator('#root')).toHaveAttribute('data-muted', 'playing')
  await expect.poll(() => frame.locator('#muted').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0)
  await expect(frame.locator('#muted')).toHaveJSProperty('playsInline', true)
  await expect(frame.locator('#root')).toHaveAttribute('data-audible', 'NotAllowedError')
  await frame.getByRole('button', { name: 'Play with sound' }).click()
  await expect(frame.locator('#root')).toHaveAttribute('data-click', 'playing')
  await expect.poll(() => frame.locator('#audible').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0)
})
