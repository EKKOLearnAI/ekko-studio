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
  async function documentHeaders(path: string) {
    const headers: Record<string, string> = {}
    await securityHeaders()({ method: 'GET', path, query: {}, secure: false,
      get: () => '', set: (name: string, value: string) => { headers[name] = value } } as any, async () => {})
    return headers
  }
  const headers = await documentHeaders('/')
  await page.route(url => url.pathname === '/plugin-frame.html', async route => {
    const response = await route.fetch({ url: new URL('/plugin-frame.html', test.info().project.use.baseURL).href })
    await route.fulfill({ response, headers: { ...response.headers(), ...await documentHeaders('/plugin-frame.html') } })
  })
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

test('plays inline and Blob audio in trusted same-origin documents for every plugin surface', async ({ page }) => {
  await mountPlugin(page, mediaSource())
  // Every supported page and the dynamic sidebar share PluginFrame's document and permissions.
  for (const slot of ['page', 'settings', 'workspace', 'agent-settings', 'workspace-sidebar']) {
    await page.goto(`/__plugin_media__?slot=${slot}`)
    const host = page.locator('iframe'), frame = page.frameLocator('iframe')
    await expect(host).not.toHaveAttribute('sandbox')
    expect(await host.getAttribute('allow')).toBeNull()
    await frame.getByRole('button', { name: 'Play data' }).click()
    await expect(frame.locator('#root')).toHaveAttribute('data-data', 'playing')
    await expect.poll(() => frame.locator('audio').nth(0).evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0)
    await frame.getByRole('button', { name: 'Play blob' }).click()
    await expect(frame.locator('#root')).toHaveAttribute('data-blob', 'playing')
    await expect.poll(() => frame.locator('audio').nth(1).evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0)
    expect(await frame.locator('#root').evaluate(() => parent.localStorage.getItem('plugin-media-sentinel'))).toBe('host-only')
  }
})

test('loads remote modules, styles, images and media and makes direct requests despite the host CSP', async ({ page }) => {
  const requests = new Set<string>()
  await page.route('https://plugin-assets.test/**', route => {
    const path = new URL(route.request().url()).pathname
    requests.add(path)
    const headers = { 'Access-Control-Allow-Origin': '*' }
    if (path === '/extra.mjs') return route.fulfill({ headers, contentType: 'text/javascript', body: 'export const value = "remote module"' })
    if (path === '/theme.css') return route.fulfill({ headers, contentType: 'text/css', body: '#root { --plugin-remote-style: loaded; }' })
    if (path === '/image.svg') return route.fulfill({ headers, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' })
    if (path === '/audio.wav') return route.fulfill({ headers, contentType: 'audio/wav', body: wav })
    return route.fulfill({ headers, json: { value: 'direct request' } })
  })
  await mountPlugin(page, `export async function mount(root) {
    root.dataset.fetch = (await (await fetch('https://plugin-assets.test/data.json')).json()).value;
    root.dataset.module = (await import('https://plugin-assets.test/extra.mjs')).value;
    root.dataset.eval = new Function('return "allowed"')();
    const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = 'https://plugin-assets.test/theme.css'; document.head.append(style);
    const image = new Image(); image.src = 'https://plugin-assets.test/image.svg'; root.append(image); await image.decode(); root.dataset.image = 'loaded';
    const audio = document.createElement('audio'); audio.src = 'https://plugin-assets.test/audio.wav';
    audio.onloadeddata = () => root.dataset.media = 'loaded'; root.append(audio); audio.load();
  }`)
  await page.goto('/__plugin_media__')
  const root = page.frameLocator('iframe').locator('#root')
  await expect(root).toHaveAttribute('data-fetch', 'direct request')
  await expect(root).toHaveAttribute('data-module', 'remote module')
  await expect(root).toHaveAttribute('data-eval', 'allowed')
  await expect(root).toHaveAttribute('data-image', 'loaded')
  await expect(root).toHaveAttribute('data-media', 'loaded')
  await expect.poll(() => root.evaluate(element => getComputedStyle(element).getPropertyValue('--plugin-remote-style').trim())).toBe('loaded')
  expect([...requests].sort()).toEqual(['/audio.wav', '/data.json', '/extra.mjs', '/image.svg', '/theme.css'])
})

test('handles the browser audio autoplay decision and supports explicit click playback', async ({ page }) => {
  await mountPlugin(page, `export function mount(root) {
    const audio = document.createElement('audio'); audio.src = ${JSON.stringify(audioData)}; root.append(audio);
    audio.play().then(() => root.dataset.auto = 'playing', error => root.dataset.auto = error.name);
    const button = document.createElement('button'); button.textContent = 'Enable sound'; root.append(button);
    button.onclick = async () => { await audio.play(); root.dataset.click = 'playing' };
    return () => audio.pause();
  }`)
  await page.goto('/__plugin_media__')
  const frame = page.frameLocator('iframe')
  // Same-origin frames may autoplay; browsers can still require a user gesture.
  await expect(frame.locator('#root')).toHaveAttribute('data-auto', /^(playing|NotAllowedError)$/)
  if (await frame.locator('#root').getAttribute('data-auto') === 'playing') {
    await expect.poll(() => frame.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0)
  }
  await frame.getByRole('button', { name: 'Enable sound' }).click()
  await expect(frame.locator('#root')).toHaveAttribute('data-click', 'playing')
})

test('plays data and Blob video on click in an unrestricted plugin document', async ({ page }) => {
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
  await expect(page.locator('iframe')).not.toHaveAttribute('sandbox')
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
  await expect(frame.locator('#root')).toHaveAttribute('data-audible', /^(playing|NotAllowedError)$/)
  if (await frame.locator('#root').getAttribute('data-audible') === 'playing') {
    await expect.poll(() => frame.locator('#audible').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0)
  }
  await frame.getByRole('button', { name: 'Play with sound' }).click()
  await expect(frame.locator('#root')).toHaveAttribute('data-click', 'playing')
  await expect.poll(() => frame.locator('#audible').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0)
})
