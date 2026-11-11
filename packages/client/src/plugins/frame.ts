import { createStudioApi } from '../../../plugin-sdk/src'
import type { ClientContext, ClientModule, Dispose, PluginEvent, PluginStorage } from '../../../plugin-sdk/src'

// Serialized into an opaque-origin frame. Keep this function self-contained.
function bootstrap(apiFactory: typeof createStudioApi, loadModule: (url: string) => Promise<ClientModule>) {
  let initialized = false
  window.addEventListener('message', async function initialize(event) {
    if (initialized || event.source !== parent || event.data?.type !== 'studio.plugin.init') return
    initialized = true
    const { channel, source, context, theme } = event.data
    const pending = new Map<number, { resolve(value: any): void; reject(reason: Error): void }>()
    const listeners = new Map<string, Set<(value: PluginEvent) => void>>()
    const disposers: Dispose[] = []
    const controller = new AbortController()
    let sequence = 0
    for (const [name, value] of Object.entries(theme || {})) document.documentElement.style.setProperty(name, String(value))
    const send = (value: unknown) => parent.postMessage({ channel, ...value as object }, '*')
    const call = <T = any>(method: string, args: unknown): Promise<T> => {
      if (controller.signal.aborted) return Promise.reject(new Error('Plugin view is closed'))
      const id = ++sequence
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ type: 'request', id, method, args }) })
    }
    window.addEventListener('message', async event => {
      if (event.source !== parent || event.data?.channel !== channel) return
      const message = event.data
      if (message.type === 'response') {
        const request = pending.get(message.id); pending.delete(message.id)
        if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.value)
      } else if (message.type === 'event') {
        const matches = (pattern: string) => pattern === message.event.type || pattern === '*' || pattern.endsWith('.*') && message.event.type.startsWith(pattern.slice(0, -1))
        for (const listener of new Set([...listeners].filter(([pattern]) => matches(pattern)).flatMap(([, entries]) => [...entries]))) {
          try { listener(message.event) } catch (error) { send({ type: 'error', message: String(error) }) }
        }
      } else if (message.type === 'theme') {
        for (const [name, value] of Object.entries(message.theme || {})) document.documentElement.style.setProperty(name, String(value))
      } else if (message.type === 'dispose') {
        controller.abort()
        for (const request of pending.values()) request.reject(new Error('Plugin view is closed'))
        pending.clear()
        for (const dispose of disposers.reverse()) { try { await dispose() } catch { /* Frame is closing. */ } }
      }
    })
    const api = apiFactory((path, options = {}) => call('api', { path, options }))
    const storage = (namespace: string[] = []): PluginStorage => ({
      namespace: (...segments) => storage([...namespace, ...segments]),
      get: key => call('storage', { action: 'get', key, namespace }).then(result => result.present ? result.value : undefined),
      set: async (key, value) => { await call('storage', { action: 'set', key, value, namespace }) },
      delete: async key => { await call('storage', { action: 'delete', key, namespace }) },
      keys: () => call('storage', { action: 'keys', namespace }).then(result => result.keys),
    })
    const ctx: ClientContext = {
      ...context, signal: controller.signal,
      api, models: api.models,
      rpc: (name, input = null) => call('rpc', { name, input }),
      storage: storage(),
      events: { on(type, listener) { const entries = listeners.get(type) || new Set(); entries.add(listener); listeners.set(type, entries); return () => { entries.delete(listener) } } },
      ui: {
        notify: (message, level = 'info') => { void call('notify', { message, level }).catch(() => {}) },
        confirm: message => call('confirm', { message }), prompt: message => call('prompt', { message }),
        navigate: path => { void call('navigate', { path }).catch(() => {}) },
      },
      onDispose: dispose => { disposers.push(dispose) },
    }
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    try {
      const module = await loadModule(url)
      if (typeof module.mount !== 'function') throw new Error('Client plugin must export mount(element, ctx)')
      const dispose = await module.mount(document.getElementById('root')!, ctx)
      if (dispose) { if (controller.signal.aborted) await dispose(); else disposers.push(dispose) }
      send({ type: 'mounted' })
    } catch (error) { send({ type: 'error', message: String(error) }) }
    finally { URL.revokeObjectURL(url) }
    const observer = new ResizeObserver(() => send({ type: 'height', value: document.body.scrollHeight }))
    observer.observe(document.body); disposers.push(() => observer.disconnect())
  })
  parent.postMessage({ type: 'studio.plugin.ready' }, '*')
}

export function pluginFrameDocument(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'"><style>html,body{margin:0;background:transparent;color:var(--text-primary);font:14px system-ui}#root{padding:12px;box-sizing:border-box}button,input,textarea,select{font:inherit;color:inherit;background:var(--bg-secondary,transparent);border:1px solid var(--border-color);border-radius:6px;padding:6px}button{cursor:pointer}*{box-sizing:border-box}</style></head><body><main id="root"></main><script type="module">(${bootstrap.toString()})(${createStudioApi.toString()},url=>import(url))</script></body></html>`
}
