import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { pathToFileURL } from 'node:url'
import type { ApiRequest, Capability, Dispose, HookResult, Json, PluginAction, PluginCommand, PluginContext, PluginEvent, PluginHook, PluginIdentity, PluginModule, PluginRecord, PluginTool, RunContext, ToolResult } from '../../contracts/plugins'
import { createStudioApi } from '../../../../../../plugin-sdk/src'
import { PluginEffects } from './effects'
import { PluginError, message } from './errors'
import { importPlugin } from './loader.cjs'
import { pluginFile } from './installer'
import { identifier, json, validate, validateSchema } from './schema'
import type { PluginStore } from './store'

export interface PluginPorts {
  api(identity: PluginIdentity, path: string, options: ApiRequest, signal: AbortSignal): Promise<Json>
  authorize(identity: PluginIdentity): void | Promise<void>
  emit(pluginId: string, event: PluginEvent): void
  log(pluginId: string, identity: PluginIdentity, level: string, text: string, data?: Json): void
  callTool?(identity: PluginIdentity, name: string, input: Record<string, Json>, signal: AbortSignal): Promise<ToolResult>
}
type Handler = (input: Json, ctx: RunContext) => Promise<Json> | Json
type Listener = (event: PluginEvent, ctx: RunContext) => void | Promise<void>
type Hook = { priority: number; handler(value: Json, ctx: RunContext): HookResult | Promise<HookResult> }

export class PluginRuntime {
  readonly effects = new PluginEffects()
  readonly tools = new Map<string, PluginTool>()
  readonly commands = new Map<string, PluginCommand>()
  readonly actions = new Map<string, PluginAction>()
  readonly rpc = new Map<string, Handler>()
  readonly listeners = new Map<string, Set<Listener>>()
  readonly hooks = new Map<PluginHook, Hook[]>()
  private schedules = new Map<string, { interval: number; action: string; input: Record<string, Json> }>()
  private calls = new Set<Promise<unknown>>()
  private started = false
  private invocation = new AsyncLocalStorage<{ identity: PluginIdentity; signal: AbortSignal }>()
  constructor(readonly record: PluginRecord, readonly identity: PluginIdentity, readonly store: PluginStore, readonly ports: PluginPorts) {}
  require(capability: Capability): void {
    this.effects.assertActive()
    if (!this.record.manifest.capabilities.includes(capability)) throw new PluginError(`Plugin requires ${capability}`, 'PLUGIN_CAPABILITY', 403)
  }
  private register<T>(map: Map<string, T>, name: string, value: T): Dispose {
    this.effects.assertActive(); identifier(name)
    if (map.has(name)) throw new PluginError(`Duplicate registration: ${name}`)
    map.set(name, value)
    return this.effects.add(() => { if (map.get(name) === value) map.delete(name) })
  }
  async load(module?: PluginModule): Promise<void> {
    const m = this.record.manifest
    if (!m.server) return
    try {
      module ||= await importPlugin(`${pathToFileURL(await pluginFile(this.record.directory, m.server)).href}?instance=${randomUUID()}`)
      if (typeof module.apply !== 'function') throw new PluginError('Server plugin must export apply(ctx)')
      const dispose = await module.apply(this.context())
      if (dispose) this.effects.add(dispose)
    } catch (error) { await this.effects.close().catch(() => {}); throw error }
  }
  activate(): void {
    this.effects.assertActive()
    if (this.started) return
    this.started = true
    for (const [id, schedule] of this.schedules) {
      if (!this.actions.has(schedule.action)) throw new PluginError(`Schedule ${id} references an unknown action`)
      let running = false
      const timer = setInterval(() => {
        if (running || this.effects.controller.signal.aborted) return
        running = true
        void this.invoke('action', schedule.action, schedule.input, { ...this.identity, surface: 'schedule' })
          .catch(error => this.log('error', `Schedule ${id}: ${message(error)}`)).finally(() => { running = false })
      }, schedule.interval)
      timer.unref()
      this.effects.add(() => clearInterval(timer))
    }
  }
  async close(): Promise<void> {
    await this.effects.close()
    await Promise.allSettled([...this.calls])
  }
  private current() { return this.invocation.getStore() || { identity: this.identity, signal: this.effects.controller.signal } }
  private log(level: string, text: string, data?: Json, identity = this.current().identity) { this.ports.log(this.record.manifest.id, identity, level, text.slice(0, 4000), data) }
  context(): PluginContext {
    const self = this
    const assertActive = () => { this.effects.assertActive(); this.current().signal.throwIfAborted() }
    const api = createStudioApi(<T = Json>(path: string, options?: ApiRequest) => {
      const current = this.current()
      return this.api(current.identity, current.signal).request<T>(path, options)
    })
    return {
      plugin: Object.freeze(structuredClone(this.record.manifest)), get identity() { return Object.freeze({ ...self.current().identity }) },
      config: Object.freeze(structuredClone(this.record.config)), get signal() { return self.current().signal },
      storage: this.store.storage(this.record.manifest.id, assertActive),
      api, models: api.models,
      log: { info: (text, data) => this.log('info', text, data), warn: (text, data) => this.log('warn', text, data), error: (text, data) => this.log('error', text, data) },
      tools: { register(tool) { self.require('tools'); validateSchema(tool.inputSchema); return self.register(self.tools, tool.name, tool) } },
      commands: { register(command) { self.require('commands'); return self.register(self.commands, command.name, command) } },
      rpc: { register: (name, handler) => this.register(this.rpc, name, handler) },
      on(type, handler) {
        self.require('events')
        const entries = self.listeners.get(type) || new Set<Listener>(); self.listeners.set(type, entries); entries.add(handler)
        return self.effects.add(() => { entries.delete(handler) })
      },
      hooks: { register(name, handler, priority = 0) {
        self.require('hooks')
        if (!['input.transform', 'context.transform', 'tool.before', 'tool.after'].includes(name) || !Number.isFinite(priority)) throw new PluginError('Unknown hook or priority')
        const entry = { priority, handler }; const entries = self.hooks.get(name) || []; entries.push(entry); entries.sort((a, b) => a.priority - b.priority); self.hooks.set(name, entries)
        return self.effects.add(() => { const index = entries.indexOf(entry); if (index >= 0) entries.splice(index, 1) })
      } },
      automation: {
        register(action) { self.require('automation'); validateSchema(action.inputSchema); return self.register(self.actions, action.name, action) },
        every(id, interval, action, input = {}) {
          self.require('automation')
          if (self.started) throw new PluginError('Schedules must be registered during apply')
          if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 2_147_483_647) throw new PluginError('Schedule interval must be 1 second to 24 days')
          return self.register(self.schedules, id, { interval, action, input })
        },
      },
      effect: acquire => this.effects.acquire(acquire), onDispose: dispose => { this.effects.add(dispose) },
    }
  }
  private api(identity: PluginIdentity, signal: AbortSignal) {
    return createStudioApi(async <T = Json>(path: string, options: ApiRequest = {}) => {
      signal.throwIfAborted(); this.require(!options.method || options.method === 'GET' ? 'api.read' : 'api.write')
      return await this.ports.api(identity, path, options, signal) as T
    })
  }
  runContext(identity: PluginIdentity, signal: AbortSignal): RunContext {
    const active = () => { this.effects.assertActive(); signal.throwIfAborted() }
    const api = this.api(identity, signal)
    return {
      identity: Object.freeze({ ...identity }), signal,
      capabilities: Object.freeze(['api', 'events', 'tools', 'commands', 'automation', ...(identity.runtime === 'ekko-agent' ? ['input.transform', 'context.transform', 'tool.before', 'tool.after'] : [])]),
      api, models: api.models, config: Object.freeze(structuredClone(this.record.config)),
      storage: this.store.storage(this.record.manifest.id, active),
      session: { get: () => { active(); if (!identity.sessionId) throw new PluginError('No session in this context'); return api.studio.sessions.get(identity.sessionId) } },
      workspace: {
        read: path => { active(); if (!identity.sessionId || !identity.workspace) throw new PluginError('No session workspace in this context'); return api.request(`/api/studio/sessions/${encodeURIComponent(identity.sessionId)}/workspace-file/read`, { query: { path } }) },
        write: (path, content) => { active(); if (!identity.sessionId || !identity.workspace) throw new PluginError('No session workspace in this context'); return api.request(`/api/studio/sessions/${encodeURIComponent(identity.sessionId)}/workspace-file/write`, { method: 'PUT', body: { path, content } }) },
      },
      tools: { call: async (name, input) => { active(); this.require('tools'); if (!this.ports.callTool) throw new PluginError('Tool dispatcher unavailable'); return this.ports.callTool(identity, name, input, signal) } },
      ui: {
        notify: (text, level = 'info') => this.emit('ui.notification', { message: text, level }, identity, active),
        emit: (type, data, options) => this.emit(type, data, identity, active, options?.audience),
      },
    }
  }
  private emit(type: string, data: Json, identity: PluginIdentity, active: () => void, audience: 'caller' | 'plugin' = 'caller') {
    active(); this.require('ui')
    if (!['caller', 'plugin'].includes(audience)) throw new PluginError('Invalid event audience')
    this.ports.emit(this.record.manifest.id, { id: randomUUID(), type, data: json(data), identity, timestamp: Date.now(), audience })
  }
  async invoke(kind: 'rpc' | 'tool' | 'command' | 'action', name: string, input: Json, identity: PluginIdentity, signal?: AbortSignal): Promise<Json> {
    return this.run(identity, signal, async ctx => {
      if (kind === 'rpc') { const handler = this.rpc.get(name); if (!handler) throw new PluginError('Unknown plugin RPC', 'PLUGIN_NOT_FOUND', 404); return handler(input, ctx) }
      if (kind === 'command') { const command = this.commands.get(name); if (!command) throw new PluginError('Unknown plugin command', 'PLUGIN_NOT_FOUND', 404); return await command.execute(String(input || ''), ctx) ?? null }
      const target = kind === 'tool' ? this.tools.get(name) : this.actions.get(name)
      if (!target) throw new PluginError(`Unknown plugin ${kind}`, 'PLUGIN_NOT_FOUND', 404)
      validate(target.inputSchema, input)
      return json(await target.execute(input as Record<string, Json>, ctx))
    })
  }
  async observe(event: PluginEvent): Promise<void> {
    const matches = (pattern: string) => pattern === event.type || pattern === '*' || pattern.endsWith('.*') && event.type.startsWith(pattern.slice(0, -1))
    const listeners = new Set([...this.listeners].filter(([pattern]) => matches(pattern)).flatMap(([, entries]) => [...entries]))
    for (const listener of listeners) {
      try { await this.run(event.identity, undefined, async ctx => { await listener(structuredClone(event), ctx); return null }) }
      catch (error) { this.log('error', `Event ${event.type}: ${message(error)}`, undefined, event.identity) }
    }
  }
  async transform(name: PluginHook, value: Json, identity: PluginIdentity, signal?: AbortSignal): Promise<HookResult> {
    return await this.run(identity, signal, async ctx => {
      let current = structuredClone(value)
      for (const hook of this.hooks.get(name) || []) {
        const result = await hook.handler(current, ctx)
        if (result.deny) return json({ deny: result.deny })
        if (result.value !== undefined) current = json(result.value)
      }
      return json({ value: current })
    }) as HookResult
  }
  private async run(identity: PluginIdentity, external: AbortSignal | undefined, work: (ctx: RunContext) => Promise<Json>): Promise<Json> {
    this.effects.assertActive(); await this.ports.authorize(identity)
    const lifetime = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, this.effects.controller.signal, AbortSignal.timeout(120_000), ...(external ? [external] : [])])
    signal.throwIfAborted()
    let rejectAbort: (() => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(signal.reason); signal.addEventListener('abort', rejectAbort, { once: true }) })
    const call = this.invocation.run({ identity, signal }, () => Promise.race([Promise.resolve().then(() => work(this.runContext(identity, signal))), aborted]))
    this.calls.add(call)
    try { return json(await call) }
    catch (error) { this.log('error', message(error), undefined, identity); throw error }
    finally { if (rejectAbort) signal.removeEventListener('abort', rejectAbort); lifetime.abort(); this.calls.delete(call) }
  }
}
