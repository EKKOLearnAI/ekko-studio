import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { DSH_UI_SLOT_CLIENT } from '../../packages/server/src/modules/coding-agents/services/dsh/ui-slot'

it('bridges only named Studio theme tokens from the parent and removes reset overrides', () => {
  const properties = new Map<string, string>()
  let receive: (event: any) => void = () => {}
  let preference = 'light'
  const context: any = {
    URL, queueMicrotask, parent: {}, location: new URL('https://studio.example/native/?studioTheme=dark'),
    document: { documentElement: { style: { setProperty: (name: string, value: string) => properties.set(name, value), removeProperty: (name: string) => properties.delete(name) }, classList: { toggle: () => {} } } },
  }
  const ctx = {
    effect: (effect: () => void) => effect(),
    locale: { bind: () => (key: string) => key, getSnapshot: () => ({ active: 'en' }), subscribe: () => () => {} },
    theme: { register: () => () => {}, getTheme: () => ({ themes: [{ id: 'light' }, { id: 'dark' }], preference }), setTheme: (id: string) => { preference = id } },
    on: () => () => {}, slots: { register: () => {} },
  }
  context.window = { __ModuleLoader__: { load: ({ factory }: any) => factory(() => ({})).apply(ctx) }, addEventListener: (_name: string, handler: typeof receive) => { receive = handler } }
  runInNewContext(DSH_UI_SLOT_CLIENT, context)
  const data = { type: 'studio-dsh-theme', theme: 'light', variables: { '--text-primary': '#123456', '--theme-input-radius': '12px', '--bg-primary': 'url(https://invalid.example)', '--unknown': 'red' } }
  receive({ source: {}, origin: context.location.origin, data })
  expect(properties.has('--text-primary')).toBe(false)
  receive({ source: context.parent, origin: context.location.origin, data })
  expect(preference).toBe('studio-light')
  expect(properties.get('--text-primary')).toBe('#123456')
  expect(properties.get('--theme-input-radius')).toBe('12px')
  expect(properties.has('--bg-primary')).toBe(false)
  expect(properties.has('--unknown')).toBe(false)
  receive({ source: context.parent, origin: context.location.origin, data: { ...data, variables: {} } })
  expect(properties.has('--text-primary')).toBe(false)
  expect(properties.has('--theme-input-radius')).toBe(false)
})

it('keeps the native transport functional after production minification without bundling native UI packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ui-bundle-'))
  try {
    const out = join(root, 'slot.cjs')
    const result = await build({ entryPoints: ['packages/server/src/modules/coding-agents/services/dsh/ui-slot.ts'], outfile: out, bundle: true, minify: true, platform: 'node', format: 'cjs', metafile: true })
    expect(Object.keys(result.metafile!.inputs)).toEqual(['packages/server/src/modules/coding-agents/services/dsh/ui-slot.ts'])
    const { dshUiDocument } = createRequire(import.meta.url)(out)
    const mount = '/api/coding-agents/dsh/ui/fixture/'
    const html = dshUiDocument('<html><head><script src="/plugins/boot.js"></script></head><body></body></html>', mount)
    expect(html).toContain(`src="${mount}plugins/boot.js"`)
    const fetched: string[] = [], sockets: string[] = [], scripts: string[] = []
    const context: any = { URL, Request, Promise, setInterval: () => 1, clearInterval: () => {}, location: new URL('https://studio.example' + mount), XMLHttpRequest: class { open() {} }, document: { createElement: () => ({}), head: { appendChild: (script: any) => { scripts.push(script.src); script.onload() } } } }
    context.window = { fetch: async (url: string) => { fetched.push(String(url)) }, addEventListener: () => {}, WebSocket: class { constructor(url: string) { sockets.push(url) } }, EventSource: class {} }
    runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context)
    await context.window.fetch('/plugin-owned/config')
    new context.window.WebSocket('wss://studio.example/api/remote.mux')
    await context.window.__DSH_TRANSPORT__.loadBundle('/plugins/native.js')
    expect(fetched).toEqual(['https://studio.example' + mount + 'plugin-owned/config'])
    expect(sockets).toEqual(['wss://studio.example' + mount + 'api/remote.mux'])
    expect(scripts).toEqual(['https://studio.example' + mount + 'plugins/native.js'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
