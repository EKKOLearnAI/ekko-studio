import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import AdmZip from 'adm-zip'
import { animatedThemeBackground, animatedThemeFormats } from '../fixtures/animated-theme-background'

describe('theme library HTTP routes', () => {
  let db: any
  let server: Server
  let root: string
  let base: string

  beforeEach(async () => {
    vi.resetModules()
    root = await mkdtemp(join(tmpdir(), 'studio-theme-routes-'))
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db }))
    vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({ config: { appHome: root } }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    const { default: Koa } = await import('koa')
    const { bodyParser } = await import('@koa/bodyparser')
    const { themeRoutes } = await import('../../packages/server/src/modules/studio/routes/theme')
    const app = new Koa()
    app.use(async (ctx, next) => {
      const id = ctx.get('x-test-user')
      if (id) ctx.state.user = { id: Number(id) }
      await next()
    })
    app.use(bodyParser())
    app.use(themeRoutes.routes())
    server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    })
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    db?.close()
    await rm(root, { recursive: true, force: true })
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.doUnmock('../../packages/server/src/modules/studio/public/config')
    vi.resetModules()
  })

  async function request(path: string, method = 'GET', body?: unknown, user = '1') {
    return fetch(`${base}/api/theme${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  it('authenticates operations, validates input and persists the active selection', async () => {
    expect((await request('/presets', 'GET', undefined, '')).status).toBe(401)
    expect((await request('/presets', 'POST', { name: '' })).status).toBe(400)
    const original = await (await request('/presets')).json() as any
    const createdResponse = await request('/presets', 'POST', { name: 'Night', brightness: 'dark', style: 'ink' })
    expect(createdResponse.status).toBe(200)
    const created = await createdResponse.json() as any
    expect(created.theme.brightness).toBe('dark')
    expect((await request(`/presets/${created.activeId}`, 'PATCH', { name: 'Evening' })).status).toBe(200)
    expect((await request(`/presets/${created.activeId}/activate`, 'POST', undefined, '2')).status).toBe(404)
    expect((await request('', 'PUT', { presetId: original.activeId, fontSize: 20 })).status).toBe(409)
    expect((await request(`/background?presetId=${original.activeId}`, 'DELETE')).status).toBe(409)
    expect((await request('/background?presetId=missing')).status).toBe(404)
    expect((await request(`/presets/${original.activeId}/activate`, 'POST')).status).toBe(200)
    expect((await (await request('')).json() as any).activePresetId).toBe(original.activeId)
    const afterDelete = await (await request(`/presets/${created.activeId}`, 'DELETE')).json() as any
    expect(afterDelete.themes).toHaveLength(1)
    expect((await request(`/presets/${original.activeId}`, 'DELETE')).status).toBe(400)
  })

  it.each(animatedThemeFormats)('preserves animated $format backgrounds through upload, download and theme ZIPs', async ({ format, mime, storedMime, extension }) => {
    const initial = await (await request('/presets')).json() as any
    const image = await animatedThemeBackground(format)
    const name = `motion.${format}`
    const form = new FormData()
    form.append('background', new Blob([new Uint8Array(image)], { type: mime }), name)
    const uploaded = await fetch(`${base}/api/theme/background?presetId=${initial.activeId}`, {
      method: 'POST', headers: { 'x-test-user': '1' }, body: form,
    })
    expect(uploaded.status).toBe(200)
    expect((await uploaded.json() as any).background).toMatchObject({ name, mime: storedMime })
    const downloaded = await request('/background')
    expect(downloaded.headers.get('content-type')).toBe(storedMime)
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(image)

    const exported = await request(`/presets/${initial.activeId}/export`)
    const archive = Buffer.from(await exported.arrayBuffer())
    const zip = new AdmZip(archive)
    expect(zip.readFile(`background.${extension}`)).toEqual(image)
    const imported = await fetch(`${base}/api/theme/presets/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/zip', 'x-test-user': '2' }, body: new Uint8Array(archive),
    })
    expect(imported.status).toBe(200)
    expect((await imported.json() as any).theme.background).toMatchObject({ name, mime: storedMime })
    const restored = await request('/background', 'GET', undefined, '2')
    expect(restored.headers.get('content-type')).toBe(storedMime)
    expect(Buffer.from(await restored.arrayBuffer())).toEqual(image)
  })

  it('accepts 30 MiB wallpapers and their ZIPs, rejecting larger replacements without changing the theme', async () => {
    const initial = await (await request('/presets')).json() as any
    const image = randomBytes(30 * 1024 * 1024)
    // Trailing data keeps the GIF playable and the exported ZIP above the old size cap.
    const animation = await animatedThemeBackground('gif')
    animation.copy(image)
    async function upload(data: Buffer, name: string) {
      const form = new FormData()
      form.append('background', new Blob([new Uint8Array(data)], { type: 'image/gif' }), name)
      return fetch(`${base}/api/theme/background?presetId=${initial.activeId}`, {
        method: 'POST', headers: { 'x-test-user': '1' }, body: form,
      })
    }
    const uploaded = await upload(image, 'large.gif')
    expect(uploaded.status).toBe(200)
    const saved = await uploaded.json()
    expect(Buffer.from(await (await request('/background')).arrayBuffer()).equals(image)).toBe(true)

    const oversized = await upload(Buffer.concat([image, Buffer.from([0])]), 'too-large.gif')
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toEqual({ error: 'Background image exceeds the 30 MB limit' })
    expect(await (await request('')).json()).toEqual(saved)

    const exported = await request(`/presets/${initial.activeId}/export`)
    expect(exported.status).toBe(200)
    const archive = Buffer.from(await exported.arrayBuffer())
    expect(archive.length).toBeGreaterThan(30 * 1024 * 1024)
    expect(archive.length).toBeLessThan(32 * 1024 * 1024)
    const imported = await fetch(`${base}/api/theme/presets/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/zip', 'x-test-user': '2' }, body: new Uint8Array(archive),
    })
    expect(imported.status).toBe(200)
    const restored = await request('/background', 'GET', undefined, '2')
    expect(Buffer.from(await restored.arrayBuffer()).equals(image)).toBe(true)
  }, 20_000)

  it('downloads a ZIP and accepts it as an authenticated binary upload', async () => {
    const original = await (await request('/presets', 'POST', { name: '共享主题', brightness: 'dark', style: 'comic' })).json() as any
    await request('', 'PUT', { fontSize: 17, textColor: '#ddeeff', appearance: { global: { opacity: 0.4 }, regions: { card: { radius: 12 } } } })
    expect((await request(`/presets/${original.activeId}/export`, 'GET', undefined, '')).status).toBe(401)
    expect((await request(`/presets/${original.activeId}/export`, 'GET', undefined, '2')).status).toBe(404)
    const exported = await request(`/presets/${original.activeId}/export`)
    expect(exported.status).toBe(200)
    expect(exported.headers.get('content-type')).toMatch(/application\/zip/)
    expect(exported.headers.get('content-disposition')).toContain('.zip')
    expect(exported.headers.get('cache-control')).toBe('no-store')
    const data = await exported.arrayBuffer()
    const upload = (user?: string, body = data) => fetch(`${base}/api/theme/presets/import`, {
      method: 'POST', body, headers: { 'Content-Type': 'application/zip', ...(user ? { 'x-test-user': user } : {}) },
    })
    expect((await upload()).status).toBe(401)
    const imported = await upload('2')
    expect(imported.status).toBe(200)
    const result = await imported.json() as any
    expect(result.activeId).not.toBe(original.activeId)
    expect(result.theme).toMatchObject({ brightness: 'dark', style: 'comic', fontSize: 17, textColor: '#ddeeff',
      appearance: { global: { opacity: 0.4 }, regions: { card: { radius: 12 } } } })
    expect(result.themes).toHaveLength(2)
    expect((await request('/presets/import', 'POST', {})).status).toBe(415)
    expect((await upload('2', new ArrayBuffer(10))).status).toBe(400)
    expect((await (await request('/presets', 'GET', undefined, '2')).json() as any).activeId).toBe(result.activeId)
  })
})
