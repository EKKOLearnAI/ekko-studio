import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import type { ApiRequest, PluginPermission, Dispose, HookResult, Json, PluginAction, PluginCommand, PluginContext, PluginEvent, PluginHook, PluginIdentity, PluginModule, PluginRecord, PluginTool, RunContext, ToolResult, HostSession, SessionListener } from '../../contracts/plugins'
import { createHostApi } from '../../../../../../plugin-sdk/src'
import { PluginEffects } from './effects'
import { PluginError, message } from './errors'
import { importPlugin } from './loader.cjs'
import { pluginFile } from './installer'
import { identifier, json, validate, validateSchema } from './schema'
import type { PluginStore } from './store'
import { PluginAgentRuntime } from './agent-runtime'
import { toolResult, hookResult } from './agent-contracts'

export interface PluginPorts {
  sessions?(identity: PluginIdentity, sessionId: string, listener: SessionListener, signal: AbortSignal, kind: 'chat' | 'bot'): Promise<HostSession>
  browser?(identity: PluginIdentity, method: string, params: Record<string, Json>, binding: string, signal: AbortSignal): Promise<Json>
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
  readonly agents = new Map<string, PluginAgentRuntime>()
  readonly effects = new PluginEffects()
  readonly tools = new Map<string, PluginTool>()
  readonly commands = new Map<string, PluginCommand>()
  readonly actions = new Map<string, PluginAction>()
  readonly rpc = new Map<string, Handler>()
  readonly listeners = new Map<string, Set<Listener>>()
  readonly hooks = new Map<PluginHook, Hook[]>()
  private schedules = new Map<string, { interval: number; action: string; input: Record<string, Json> }>()
  private calls = new Set<Promise<unknown>>()
  private readonly browserBinding = randomUUID()
  private started = false
  private invocation = new AsyncLocalStorage<{ identity: PluginIdentity; signal: AbortSignal }>()
  constructor(readonly record: PluginRecord, readonly identity: PluginIdentity, readonly store: PluginStore, readonly ports: PluginPorts) {}
  require(capability: PluginPermission): void {
    this.effects.assertActive()
    if (!this.record.manifest.permissions.includes(capability)) throw new PluginError(`Plugin requires ${capability}`, 'PLUGIN_CAPABILITY', 403)
  }
  private register<T>(map: Map<string, T>, name: string, value: T): Dispose {
    this.effects.assertActive(); identifier(name)
    if (map.has(name)) throw new PluginError(`Duplicate registration: ${name}`)
    map.set(name, value)
    return this.effects.add(() => { if (map.get(name) === value) map.delete(name) })
  }
  async load(module?: PluginModule): Promise<void> {
    const m = this.record.manifest
    if (m.apiVersion !== 1 || !Array.isArray(m.permissions)) throw new PluginError('Plugin requires the current SDK v1 contract', 'PLUGIN_INCOMPATIBLE', 422)
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
  private lifecycle(effects = this.effects) {
    return { add: effects.add.bind(effects), acquire: effects.acquire.bind(effects) }
  }
  private state(identity: PluginIdentity, active: () => void) {
    const plugin = this.store.storage(this.record.manifest.id, active)
    return { plugin, user: plugin.namespace('sdk', 'users', String(identity.userId)),
      profile: plugin.namespace('sdk', 'profiles', String(identity.userId), identity.profile),
      ...(identity.sessionId ? { session: plugin.namespace('sdk', 'sessions', String(identity.userId), identity.profile, identity.sessionId) } : {}) }
  }
  async connectSession(identity: PluginIdentity, signal: AbortSignal, sessionId: string, listener: SessionListener, kind: 'chat' | 'bot' = 'chat'): Promise<HostSession> {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || !['chat', 'bot'].includes(kind)) throw new PluginError('Invalid session connection')
    const connection = new AbortController()
    signal = AbortSignal.any([signal, this.effects.controller.signal, connection.signal])
    const authorize = async (write = false) => {
      signal.throwIfAborted(); this.require(write ? 'api.write' : 'api.read')
      await this.ports.authorize({ ...identity, sessionId })
    }
    await authorize()
    if (!this.ports.sessions) throw new PluginError('Live session transport is unavailable', 'PLUGIN_UNAVAILABLE', 503)
    let delivery = Promise.resolve()
    const session = await this.ports.sessions(identity, sessionId, event => {
      delivery = delivery.then(async () => { await authorize(); listener(event) }).catch(error => {
        this.log('warn', `Session event delivery: ${message(error)}`, undefined, identity)
      })
    }, signal, kind)
    if (signal.aborted) { await session.close(); signal.throwIfAborted() }
    const close = this.effects.add(() => { connection.abort(); return session.close() })
    const command = async (work: () => Promise<void>, write = true) => { await authorize(write); await work() }
    return {
      sessionId, close, run: (input, options) => command(() => session.run(input, options)),
      stop: () => command(() => session.stop()), resume: () => command(() => session.resume(), false),
      queue: { insert: id => command(() => session.queue.insert(id)), cancel: id => command(() => session.queue.cancel(id)) },
      interactions: { approve: (id, choice) => command(() => session.interactions.approve(id, choice)), clarify: (id, response) => command(() => session.interactions.clarify(id, response)) },
    }
  }
  async browserRequest(identity: PluginIdentity, signal: AbortSignal, method: string, params: Record<string, Json>): Promise<Json> {
    if (!['tabs.list', 'tabs.create', 'tabs.close', 'cdp.attach', 'cdp.send', 'cdp.events', 'lease.release'].includes(method) || !params || typeof params !== 'object' || Array.isArray(params)) throw new PluginError('Invalid plugin browser request')
    signal.throwIfAborted(); this.require('browser.cdp'); await this.ports.authorize(identity)
    if (!this.ports.browser) throw new PluginError('Desktop browser is unavailable', 'PLUGIN_UNAVAILABLE', 503)
    signal.throwIfAborted()
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }) })
    try {
      const result = await Promise.race([this.ports.browser(identity, method, json(params) as Record<string, Json>, this.browserBinding, signal), cancelled])
      signal.throwIfAborted(); this.effects.assertActive()
      return json(result)
    } finally { signal.removeEventListener('abort', abort) }
  }
  context(): PluginContext {
    const self = this
    const host = createHostApi(<T = Json>(path: string, options?: ApiRequest) => {
      const current = this.current()
      return this.api(current.identity, current.signal).request<T>(path, options)
    }, (method, params) => { const current = this.current(); return this.browserRequest(current.identity, current.signal, method, params) },
    (id, listener, kind) => { const current = this.current(); return this.connectSession(current.identity, current.signal, id, listener, kind) })
    return {
      paths: Object.freeze({ dataDir: join(this.store.directory(), 'plugin-data', this.record.manifest.id) }),
      plugin: Object.freeze(structuredClone(this.record.manifest)), get identity() { return Object.freeze({ ...self.current().identity }) },
      config: Object.freeze(structuredClone(this.record.config)), get signal() { return self.current().signal },
      get state() { const current = self.current(); return self.state(current.identity, () => { self.effects.assertActive(); current.signal.throwIfAborted() }) }, host,
      log: { info: (text, data) => this.log('info', text, data), warn: (text, data) => this.log('warn', text, data), error: (text, data) => this.log('error', text, data) },
      extensions: {
        agents: { register: definition => {
          this.require('agents')
          if (this.started) throw new PluginError('Agents must be registered during apply')
          const agent = new PluginAgentRuntime(this, definition)
          const remove = this.register(this.agents, definition.id, agent)
          const close = this.effects.add(() => agent.closeSessions())
          return { id: agent.id, dispose: async () => { remove(); await close() } }
        } },
        tools: { register(tool) { self.require('tools'); validateSchema(tool.inputSchema); return self.register(self.tools, tool.name, tool) } },
        commands: { register(command) { self.require('commands'); return self.register(self.commands, command.name, command) } },
        rpc: { register: (name, handler) => this.register(this.rpc, name, handler) },
        hooks: { register(name, handler, priority = 0) {
          self.require('hooks')
          if (!['input.transform', 'context.transform', 'tool.before', 'tool.after'].includes(name) || !Number.isFinite(priority)) throw new PluginError('Unknown hook or priority')
          const entry = { priority, handler }; const entries = self.hooks.get(name) || []; entries.push(entry); self.hooks.set(name, entries)
          entries.sort((a, b) => a.priority - b.priority)
          return self.effects.add(() => { const index = entries.indexOf(entry); if (index >= 0) entries.splice(index, 1) })
        } },
        actions: { register(action) { self.require('automation'); validateSchema(action.inputSchema); return self.register(self.actions, action.name, action) } },
      },
      events: { on(type, handler) {
        self.require('events')
        const entries = self.listeners.get(type) || new Set<Listener>(); self.listeners.set(type, entries); entries.add(handler)
        return self.effects.add(() => { entries.delete(handler) })
      } },
      scheduler: { every(id, interval, action, input = {}) {
        self.require('automation')
        if (self.started) throw new PluginError('Schedules must be registered during apply')
        if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 2_147_483_647) throw new PluginError('Schedule interval must be 1 second to 24 days')
        return self.register(self.schedules, id, { interval, action, input })
      } },
      lifecycle: this.lifecycle(),
    }
  }
  private api(identity: PluginIdentity, signal: AbortSignal) {
    return createHostApi(async <T = Json>(path: string, options: ApiRequest = {}) => {
      signal.throwIfAborted(); this.require(!options.method || options.method === 'GET' ? 'api.read' : 'api.write')
      if (options.body !== undefined) json(options.body)
      return await this.ports.api(identity, path, options, signal) as T
    }, (method, params) => this.browserRequest(identity, signal, method, params),
    (id, listener, kind) => this.connectSession(identity, signal, id, listener, kind))
  }
  runContext(identity: PluginIdentity, signal: AbortSignal, effects = this.effects): RunContext {
    const active = () => { this.effects.assertActive(); signal.throwIfAborted() }
    const api = this.api(identity, signal)
    return {
      identity: Object.freeze({ ...identity }), signal,
      permissions: Object.freeze([...this.record.manifest.permissions]),
      features: Object.freeze(['api', 'events', 'tools', 'commands', 'automation', ...(identity.runtime === 'ekko-agent' ? ['input.transform', 'context.transform', 'tool.before', 'tool.after'] : [])]),
      host: api, lifecycle: this.lifecycle(effects), config: Object.freeze(structuredClone(this.record.config)),
      state: this.state(identity, active),
      session: { get: () => { active(); if (!identity.sessionId) throw new PluginError('No session in this context'); return api.sessions.get(identity.sessionId) } },
      workspace: {
        read: path => { active(); if (!identity.sessionId || !identity.workspace) throw new PluginError('No session workspace in this context'); return api.request(`/api/studio/sessions/${encodeURIComponent(identity.sessionId)}/workspace-file/read`, { query: { path } }) },
        write: (path, content) => { active(); if (!identity.sessionId || !identity.workspace) throw new PluginError('No session workspace in this context'); return api.request(`/api/studio/sessions/${encodeURIComponent(identity.sessionId)}/workspace-file/write`, { method: 'PUT', body: { path, content } }) },
      },
      tools: { call: async (name, input) => { active(); this.require('tools'); if (!this.ports.callTool) throw new PluginError('Tool dispatcher unavailable'); return this.ports.callTool(identity, name, input, signal) } },
      messages: {
        notify: (text, level = 'info') => this.emit('ui.notification', { message: text, level }, identity, active),
        emit: (type, data, options) => this.emit(type, data, identity, active, options?.audience),
      },
    }
  }
  private emit(type: string, data: Json, identity: PluginIdentity, active: () => void, audience: 'caller' | 'plugin' = 'caller') {
    active(); this.require('ui')
    if (!['caller', 'plugin'].includes(audience)) throw new PluginError('Invalid event audience')
    this.ports.emit(this.record.manifest.id, { id: randomUUID(), type, channel: 'message', data: json(data), identity, timestamp: Date.now(), audience })
  }
  async invoke(kind: 'rpc' | 'tool' | 'command' | 'action', name: string, input: Json, identity: PluginIdentity, signal?: AbortSignal): Promise<Json> {
    input = json(input)
    return this.run(identity, signal, async ctx => {
      if (kind === 'rpc') { const handler = this.rpc.get(name); if (!handler) throw new PluginError('Unknown plugin RPC', 'PLUGIN_NOT_FOUND', 404); return handler(input, ctx) }
      if (kind === 'command') { const command = this.commands.get(name); if (!command) throw new PluginError('Unknown plugin command', 'PLUGIN_NOT_FOUND', 404); return await command.execute(String(input || ''), ctx) ?? null }
      const target = kind === 'tool' ? this.tools.get(name) : this.actions.get(name)
      if (!target) throw new PluginError(`Unknown plugin ${kind}`, 'PLUGIN_NOT_FOUND', 404)
      validate(target.inputSchema, input)
      const result = await target.execute(input as Record<string, Json>, ctx)
      return kind === 'tool' ? json(toolResult(result)) : json(result)
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
        const result = hookResult(await hook.handler(current, ctx))
        if (result.deny) return json({ deny: result.deny })
        if (result.value !== undefined) current = json(result.value)
      }
      return json({ value: current })
    }) as HookResult
  }
  private async run(identity: PluginIdentity, external: AbortSignal | undefined, work: (ctx: RunContext) => Promise<Json>): Promise<Json> {
    this.effects.assertActive(); await this.ports.authorize(identity)
    const resources = new PluginEffects()
    const lifetime = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, this.effects.controller.signal, AbortSignal.timeout(120_000), ...(external ? [external] : [])])
    signal.throwIfAborted()
    let rejectAbort: (() => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(signal.reason); signal.addEventListener('abort', rejectAbort, { once: true }) })
    const call = this.invocation.run({ identity, signal }, () => Promise.race([Promise.resolve().then(() => work(this.runContext(identity, signal, resources))), aborted]))
    this.calls.add(call)
    try { return json(await call) }
    catch (error) { this.log('error', message(error), undefined, identity); throw error }
    finally { if (rejectAbort) signal.removeEventListener('abort', rejectAbort); lifetime.abort(); this.calls.delete(call); await resources.close() }
  }

  /** Agent instances use the coordinator's lifetime, independently of ordinary RPC timeouts. */
  async withIdentity<T>(identity: PluginIdentity, external: AbortSignal, work: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
    this.effects.assertActive(); await this.ports.authorize(identity)
    const lifetime = new AbortController()
    const signal = AbortSignal.any([external, lifetime.signal, this.effects.controller.signal])
    signal.throwIfAborted()
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }) })
    const call = this.invocation.run({ identity, signal }, () => Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(signal) }), cancelled]))
    this.calls.add(call)
    try { return await call } finally { signal.removeEventListener('abort', abort); lifetime.abort(); this.calls.delete(call) }
  }
}
