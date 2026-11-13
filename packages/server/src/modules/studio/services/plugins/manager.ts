import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join, relative, sep, dirname } from 'node:path'
import type { ApiRequest, HookResult, Json, PluginEvent, PluginHook, PluginIdentity, PluginRecord, PluginSnapshot, ToolResult } from '../../contracts/plugins'
import { PluginError, message } from './errors'
import { installPackage, pluginFile } from './installer'
import { PluginRuntime, type PluginPorts } from './runtime'
import { configuration, identifier, json, manifest } from './schema'
import { PluginStore, readJson, scopeKey, writeJson, type PluginState } from './store'

function previousVersion(record: PluginRecord): Omit<PluginRecord, 'previous'> {
  const { previous: _previous, ...version } = record
  return version
}
function packagePresent(record: PluginRecord): boolean { return existsSync(join(record.directory, 'plugin.json')) }
const missingPackage = () => new PluginError('Plugin package is missing; reinstall or uninstall this plugin', 'PLUGIN_PACKAGE_MISSING', 404)

export class PluginManager {
  readonly store: PluginStore
  private runtimes = new Map<string, PluginRuntime>()
  private errors = new Map<string, string>()
  private operations = new Map<string, Promise<unknown>>()
  private events = new Map<string, Array<PluginEvent & { pluginId: string; sequence: number }>>()
  readonly generation = randomUUID()
  private sequence = 0
  private closing = false
  private ports: PluginPorts
  registeredAgents() { return [...this.runtimes.values()].filter(runtime => packagePresent(runtime.record)).flatMap(runtime => [...runtime.agents.values()]) }
  constructor(home: string, ports: PluginPorts) {
    this.store = new PluginStore(home)
    this.ports = { ...ports, emit: (id, event) => { this.publish(id, event, event.audience === 'plugin'); ports.emit(id, event) },
      log: (id, identity, level, text, data) => { try { this.log(id, identity, level, text, data) } catch { /* A broken log file must not stop plugin cleanup. */ } ports.log(id, identity, level, text, data) },
      callTool: (identity, name, input, signal) => this.callTool(identity, name, input, signal),
    }
  }
  async restore(): Promise<void> {
    const state = this.store.read()
    const pending = Object.entries(state.records).filter(([, record]) => record.enabled)
    while (pending.length) {
      const index = pending.findIndex(([, record]) => Object.keys(record.manifest.dependencies || {}).every(id => !pending.some(([name]) => name === id)))
      if (index < 0) { for (const [id] of pending) this.errors.set(id, 'Circular plugin dependencies'); break }
      const [id, record] = pending.splice(index, 1)[0]
      try {
        if (!record.runtimeIdentity) throw new PluginError('Plugin needs administrator activation before it can start')
        await this.mount(record.runtimeIdentity, record)
      } catch (e) { this.errors.set(id, message(e)) }
    }
  }
  private dependencies(record: PluginRecord, state = this.store.read()): void {
    for (const [id, version] of Object.entries(record.manifest.dependencies || {})) {
      if (id === record.manifest.id || !state.records[id]?.enabled || state.records[id].manifest.version !== version || !this.runtimes.has(id)) throw new PluginError(`Required plugin ${id}@${version} is unavailable`, 'PLUGIN_DEPENDENCY', 409)
    }
  }
  private async mount(identity: PluginIdentity, record: PluginRecord): Promise<PluginRuntime> {
    if (!packagePresent(record)) throw missingPackage()
    manifest(record.manifest)
    this.dependencies(record)
    const runtime = new PluginRuntime(record, { userId: identity.userId, profile: identity.profile }, this.store, this.ports)
    try { await runtime.load(); runtime.activate() } catch (e) { await runtime.close().catch(() => {}); throw e }
    this.runtimes.set(record.manifest.id, runtime)
    this.errors.delete(record.manifest.id)
    return runtime
  }
  snapshot(_identity?: PluginIdentity): PluginSnapshot {
    const state = this.store.read()
    return { revision: state.revision, plugins: Object.values(state.records).map(record => {
      const { directory: _directory, runtimeIdentity: _runtimeIdentity, previous, ...rest } = record
      const present = packagePresent(record)
      const runtime = present ? this.runtimes.get(record.manifest.id) : undefined
      return { ...rest, status: !present ? 'failed' : runtime ? 'active' : record.enabled ? 'failed' : 'disabled',
        previousVersion: previous?.manifest.version, error: present ? this.errors.get(record.manifest.id) : missingPackage().message,
        tools: [...(runtime?.tools.values() || [])].map(({ name, description, inputSchema, readOnly }) => ({ name, description, inputSchema, readOnly })),
        commands: [...(runtime?.commands.values() || [])].map(({ name, description }) => ({ name, description })),
        actions: [...(runtime?.actions.values() || [])].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      }
    }) }
  }
  private async transaction<T>(identity: PluginIdentity, revision: number, work: (state: PluginState) => Promise<T>): Promise<T> {
    if (this.closing) throw new PluginError('Plugin host is shutting down', 'PLUGIN_EXPIRED', 409)
    const key = 'global'
    const previous = this.operations.get(key) || Promise.resolve()
    const current = previous.catch(() => {}).then(async () => {
      await this.ports.authorize(identity)
      const state = this.store.read()
      if (!Number.isSafeInteger(revision) || state.revision !== revision) throw new PluginError('Plugin settings changed; reload before saving', 'PLUGIN_REVISION', 409)
      return work(state)
    })
    this.operations.set(key, current)
    try { return await current } finally { if (this.operations.get(key) === current) this.operations.delete(key) }
  }
  async install(identity: PluginIdentity, source: string, revision: number, expectedId?: string, options?: { developmentDirectory?: string; enabled?: boolean; expectedVersion?: string }): Promise<PluginSnapshot> {
    return this.transaction(identity, revision, async state => {
      const pkg = await installPackage(this.store.directory(), source)
      try {
        const id = pkg.manifest.id
        if (expectedId && id !== expectedId) throw new PluginError('Update package has a different plugin id')
        if (options?.expectedVersion && pkg.manifest.version !== options.expectedVersion) throw new PluginError('Update package version does not match the published release')
        const old = state.records[id]
        if (old && !expectedId) throw new PluginError('Plugin already installed; use Update', 'PLUGIN_EXISTS', 409)
        const next: PluginRecord = { manifest: pkg.manifest, directory: pkg.directory, source, installedAt: Date.now(), enabled: options?.enabled ?? old?.enabled ?? false,
          ...(options?.developmentDirectory ? { developmentDirectory: options.developmentDirectory } : {}),
          config: configuration(pkg.manifest.configSchema, old?.config || {}, !!(options?.enabled ?? old?.enabled)), ...(old ? { previous: previousVersion(old) } : {}) }
        if (source.startsWith('builtin:')) (state.builtinVersions ||= {})[id] = pkg.manifest.version
        await this.replace(identity, state, id, next)
        return this.snapshot(identity)
      } catch (e) { await pkg.dispose(); throw e }
    })
  }
  private async replace(identity: PluginIdentity, state: PluginState, id: string, next: PluginRecord | undefined): Promise<void> {
    const old = state.records[id]
    const mcpName = next?.manifest.mcp?.name
    if (mcpName && mcpName !== 'ekko-studio-plugins' && Object.values(state.records).some(other => other.manifest.id !== id && other.manifest.mcp?.name === mcpName)) {
      throw new PluginError(`Plugin MCP name ${mcpName} is already used by another plugin`, 'PLUGIN_MCP_CONFLICT', 409)
    }
    if (next) next.runtimeIdentity = { userId: identity.userId, profile: identity.profile }
    for (const other of Object.values(state.records)) {
      const required = other.manifest.dependencies?.[id]
      if (other.enabled && other.manifest.id !== id && required && (!next?.enabled || next.manifest.version !== required)) throw new PluginError(`Disable dependent plugin ${other.manifest.id} first`, 'PLUGIN_DEPENDENCY', 409)
    }
    const key = id
    const oldRuntime = this.runtimes.get(key)
    this.runtimes.delete(key)
    try {
      await oldRuntime?.close()
      if (next) state.records[id] = next; else delete state.records[id]
      if (next?.enabled) await this.mount(identity, next)
      this.store.write(state, state.revision)
      this.errors.delete(key)
      this.publish(id, { id: randomUUID(), type: 'plugin.changed', timestamp: Date.now(), identity, data: null }, true)
    } catch (error) {
      await this.runtimes.get(key)?.close().catch(() => {}); this.runtimes.delete(key)
      if (old?.enabled) await this.mount(old.runtimeIdentity || identity, old).catch(e => this.errors.set(key, message(e)))
      throw error
    }
  }
  async update(identity: PluginIdentity, id: string, revision: number, input: { enabled?: boolean; config?: Record<string, Json>; action?: 'reload' | 'rollback' | 'uninstall' | 'stop-development' }): Promise<PluginSnapshot> {
    identifier(id)
    return this.transaction(identity, revision, async state => {
      const record = state.records[id]
      if (!record) throw new PluginError('Plugin not found', 'PLUGIN_NOT_FOUND', 404)
      let next: PluginRecord | undefined = structuredClone(record)
      if (input.action === 'uninstall') {
        next = undefined
        // An explicitly removed local/market installation must not reappear as a
        // bundled plugin on the next list request or restart.
        state.builtinVersions ||= {}
        state.builtinVersions[id] ||= record.manifest.version
      } else if (input.action === 'rollback') {
        if (!record.previous) throw new PluginError('No previous plugin version')
        next = { ...record.previous, enabled: record.enabled, previous: previousVersion(record) }
        delete next.developmentDirectory
      } else {
        if (input.action === 'stop-development') delete next.developmentDirectory
        if (input.enabled !== undefined) next.enabled = input.enabled
        if (input.config !== undefined) next.config = configuration(next.manifest.configSchema, input.config)
      }
      if (next?.enabled) next.config = configuration(next.manifest.configSchema, next.config)
      if (input.action === 'stop-development' && input.enabled === undefined && input.config === undefined) {
        state.records[id] = next!
        this.store.write(state, state.revision)
        this.publish(id, { id: randomUUID(), type: 'plugin.changed', timestamp: Date.now(), identity, data: null }, true)
      } else await this.replace(identity, state, id, next)
      return this.snapshot(identity)
    })
  }
  runtime(_identity: PluginIdentity, id: string): PluginRuntime {
    const value = this.runtimes.get(id)
    const record = this.store.read().records[id]
    if (record && !packagePresent(record)) throw missingPackage()
    if (!value) throw new PluginError('Plugin is disabled or unavailable', 'PLUGIN_UNAVAILABLE', 409)
    return value
  }
  async client(identity: PluginIdentity, id: string): Promise<string> {
    const runtime = this.runtime(identity, id); runtime.require('ui')
    const entry = runtime.record.manifest.client
    if (!entry) throw new PluginError('Plugin has no frontend')
    const source = await readFile(await pluginFile(runtime.record.directory, entry), 'utf8')
    if (Buffer.byteLength(source) > 8_000_000) throw new PluginError('Client bundle exceeds 8 MB')
    return source
  }
  async request(identity: PluginIdentity, id: string, path: string, options: ApiRequest, signal?: AbortSignal): Promise<Json> {
    const runtime = this.runtime(identity, id)
    await this.ports.authorize(identity)
    const combined = AbortSignal.any([runtime.effects.controller.signal, ...(signal ? [signal] : [])])
    return runtime.runContext(identity, combined).host.request(path, options)
  }
  async callTool(identity: PluginIdentity, name: string, input: Record<string, Json>, signal?: AbortSignal): Promise<ToolResult> {
    const [id, tool, extra] = name.split('/')
    if (!id || !tool || extra) throw new PluginError('Plugin tools use plugin-id/tool-name')
    return await this.runtime(identity, id).invoke('tool', tool, input, identity, signal) as unknown as ToolResult
  }
  async transform(identity: PluginIdentity, hook: PluginHook, value: Json, signal?: AbortSignal): Promise<HookResult> {
    let current = value
    for (const runtime of [...this.runtimes.values()].sort((a, b) => a.record.manifest.id.localeCompare(b.record.manifest.id))) {
      if (!runtime.hooks.get(hook)?.length) continue
      const result = await runtime.transform(hook, current, identity, signal)
      if (result.deny) return result
      if (result.value !== undefined) current = result.value
    }
    return { value: current }
  }
  hasHooks(_identity: PluginIdentity, hook: PluginHook): boolean {
    return [...this.runtimes.values()].some(runtime => !!runtime.hooks.get(hook)?.length)
  }
  async dispatch(event: PluginEvent): Promise<void> {
    await this.ports.authorize(event.identity)
    for (const runtime of this.runtimes.values()) {
      this.publish(runtime.record.manifest.id, event)
      await runtime.observe(event)
    }
  }
  private publish(pluginId: string, event: PluginEvent, global = false) {
    const key = global ? 'global' : scopeKey(event.identity); const buffer = this.events.get(key) || []
    buffer.push({ ...event, data: json(event.data), pluginId, sequence: ++this.sequence })
    if (buffer.length > 500) buffer.splice(0, buffer.length - 500)
    this.events.set(key, buffer)
  }
  poll(identity: PluginIdentity, cursor: number, pluginId?: string) {
    const events = [...(this.events.get(scopeKey(identity)) || []), ...(this.events.get('global') || [])]
    return { generation: this.generation, cursor: this.sequence, events: events.filter(e => e.sequence > cursor && (!pluginId || e.pluginId === pluginId) && (e.audience === 'plugin' || !identity.sessionId || !e.identity.sessionId || e.identity.sessionId === identity.sessionId)).sort((a, b) => a.sequence - b.sequence) }
  }
  private log(id: string, identity: PluginIdentity, level: string, text: string, data?: Json) {
    const file = join(this.store.directory(), 'logs', `${identifier(id)}.json`)
    const entries = readJson<Json[]>(file, () => [])
    entries.push({ timestamp: Date.now(), level, message: text, identity: json(Object.fromEntries(Object.entries(identity).filter(([, value]) => value !== undefined))), ...(data === undefined ? {} : { data: json(data) }) })
    writeJson(file, entries.slice(-200))
  }
  logs(_identity: PluginIdentity, id: string) { return readJson<Json[]>(join(this.store.directory(), 'logs', `${identifier(id)}.json`), () => []) }
  async pruneDevelopmentPackage(directory: string): Promise<void> {
    const versions = join(this.store.directory(), 'versions')
    const parts = relative(versions, directory).split(sep)
    if (parts.length !== 2 || !/^[a-f0-9-]{36}$/.test(parts[0]) || parts[1] !== 'package') return
    if (Object.values(this.store.read().records).some(record => record.directory === directory || record.previous?.directory === directory)) return
    await rm(dirname(directory), { recursive: true, force: true }).catch(() => {})
  }
  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.operations.values()])
    await Promise.allSettled([...this.runtimes.values()].reverse().map(r => r.close()))
    this.runtimes.clear()
  }
}
