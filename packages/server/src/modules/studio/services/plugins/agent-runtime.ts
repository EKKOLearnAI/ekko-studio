import { mkdir } from 'node:fs/promises'
import type { AgentDefinition, AgentEvent, AgentManagementContext, AgentMode, AgentRunContext, AgentRunInput, AgentRunResult, AgentScopedModel, AgentSession, PluginIdentity } from '../../contracts/plugins'
import { PluginEffects } from './effects'
import { PluginError } from './errors'
import { identifier, json } from './schema'
import { agentStatus, agentSettings, agentUpdate, agentUpgrade, agentModels, agentCheckpoint, agentResult, agentEvent } from './agent-contracts'
import type { PluginRuntime } from './runtime'

export function pluginAgentId(plugin: string, agent: string): `plugin:${string}/${string}` { return `plugin:${identifier(plugin)}/${identifier(agent)}` }
export function isPluginAgentId(value: unknown): value is `plugin:${string}/${string}` {
  if (typeof value !== 'string' || !value.startsWith('plugin:')) return false
  const parts = value.slice(7).split('/')
  try { return parts.length === 2 && parts.every(part => identifier(part) === part) } catch { return false }
}
export function validateAgent(definition: AgentDefinition): void {
  identifier(definition?.id)
  for (const key of ['name', 'vendor'] as const) if (typeof definition[key] !== 'string' || !definition[key].trim() || definition[key].length > 160) throw new PluginError(`Agent ${key} is required`)
  if (definition.agentApiVersion !== 1 || typeof definition.getStatus !== 'function' || typeof definition.runtime?.createSession !== 'function') throw new PluginError('Agent requires API v1, getStatus and runtime.createSession')
  if (!definition.management || typeof definition.management !== 'object') throw new PluginError('Agent management is required')
  for (const key of ['settings', 'checkUpdate', 'upgrade', 'remove', 'supportsAutoUpdate'] as const) if (definition.management[key] !== undefined && typeof definition.management[key] !== 'function') throw new PluginError(`Invalid Agent ${key} handler`)
  if (definition.management.upgrade && !definition.management.checkUpdate) throw new PluginError('Agent upgrade requires checkUpdate')
  if (definition.management.supportsAutoUpdate && !definition.management.upgrade) throw new PluginError('Agent automatic updates require upgrade and checkUpdate')
  const modes = definition.modes
  if (!modes || !modes.global && !modes.scoped || Object.keys(modes).some(key => !['global', 'scoped'].includes(key))) throw new PluginError('Agent must declare scoped or global mode')
  if (modes.global && typeof modes.global.listModels !== 'function') throw new PluginError('Global Agent requires listModels')
  if (modes.scoped && (!Array.isArray(modes.scoped.protocols) || !modes.scoped.protocols.length || modes.scoped.protocols.some(value => !['chat_completions', 'codex_responses', 'anthropic_messages'].includes(value)))) throw new PluginError('Scoped Agent requires supported protocols')
  const features = definition.features
  if (!features || !Array.isArray(features.surfaces) || !features.surfaces.length || features.surfaces.some(value => !['chat', 'group-chat', 'workflow', 'api'].includes(value)) || typeof features.streaming !== 'boolean' || typeof features.resume !== 'boolean') throw new PluginError('Invalid Agent features')
  if ('images' in features || 'files' in features || 'supportsImages' in features || 'supportsFiles' in features) throw new PluginError('Images and files are required Agent inputs, not optional capabilities')
}

type Entry = { effects: PluginEffects; engine: Promise<AgentSession>; busy: boolean }
let activitySequence = 0
async function closeEffects(effects: PluginEffects): Promise<void> {
  const closing = effects.close()
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([closing, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); timer.unref() })]) }
  finally { if (timer) clearTimeout(timer); void closing.catch(() => {}) }
}
export class PluginAgentRuntime {
  readonly id: `plugin:${string}/${string}`
  private sessions = new Map<string, Entry>()
  private updating = false
  private activity = ++activitySequence
  isBusyForUpdate() { return this.updating || [...this.sessions.values()].some(entry => entry.busy) }
  activityRevision() { return this.activity }
  constructor(readonly owner: PluginRuntime, readonly definition: AgentDefinition) {
    validateAgent(definition)
    this.id = pluginAgentId(owner.record.manifest.id, definition.id)
  }
  descriptor() {
    const d = this.definition
    return { id: this.id, pluginId: this.owner.record.manifest.id, name: d.name, vendor: d.vendor, description: d.description || '',
      icon: d.icon || this.owner.record.manifest.icon || '', origin: 'plugin' as const,
      modes: Object.keys(d.modes) as AgentMode[], surfaces: d.features.surfaces,
      actions: { settings: !!d.management.settings, checkUpdate: !!d.management.checkUpdate, upgrade: !!d.management.upgrade, remove: !!d.management.remove, autoUpdate: !!d.management.supportsAutoUpdate } }
  }
  async manage<T>(identity: PluginIdentity, signal: AbortSignal | undefined, work: (ctx: AgentManagementContext) => Promise<T> | T): Promise<T> {
    const effects = new PluginEffects()
    try {
      return await this.owner.withIdentity(identity, AbortSignal.any([effects.controller.signal, AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]), async bound => work({
        identity: Object.freeze({ ...identity, agentId: this.id }), signal: bound,
        log: this.owner.context().log, lifecycle: { add: dispose => effects.add(dispose), acquire: acquire => effects.acquire(acquire) },
        progress: value => { this.owner.context().log.info(value.message) },
      }))
    } finally { await closeEffects(effects) }
  }
  status(identity: PluginIdentity, signal?: AbortSignal) {
    return this.manage(identity, signal, async ctx => {
      return agentStatus(await this.definition.getStatus(ctx))
    })
  }
  async models(identity: PluginIdentity, refresh = false, signal?: AbortSignal) {
    return this.manage(identity, signal, async ctx => {
      if (!this.definition.modes.global) throw new PluginError('Agent does not support global mode')
      return agentModels(await this.definition.modes.global.listModels({ ...ctx, refresh }))
    })
  }
  async settings(identity: PluginIdentity) {
    return this.manage(identity, undefined, async ctx => {
      if (!this.definition.management.settings) throw new PluginError('Agent has no settings page')
      const target = agentSettings(await this.definition.management.settings(ctx))
      const view = this.owner.record.manifest.views?.find(view => view.id === target.viewId && view.slot === 'agent-settings')
      if (!view || target.query && (typeof target.query !== 'object' || Object.values(target.query).some(value => typeof value !== 'string'))) throw new PluginError('Agent settings must target its own declared agent-settings view')
      return { name: 'studio.pluginAgentSettings', params: { pluginId: this.owner.record.manifest.id, viewId: target.viewId }, query: target.query || {} }
    })
  }
  async checkUpdate(identity: PluginIdentity) {
    return this.manage(identity, undefined, async ctx => {
      if (!this.definition.management.checkUpdate) throw new PluginError('Agent cannot check updates')
      return agentUpdate(await this.definition.management.checkUpdate(ctx))
    })
  }
  async upgrade(identity: PluginIdentity, input: { version: string; expectedVersion: string }, options: { automatic?: boolean } = {}) {
    if (this.isBusyForUpdate()) throw new PluginError('Agent is busy; retry after its runs finish', 'AGENT_BUSY', 409)
    if (!input || typeof input.version !== 'string' || !input.version.trim() || typeof input.expectedVersion !== 'string') throw new PluginError('Exact target and expected versions are required')
    this.updating = true
    try {
      return await this.manage(identity, undefined, async ctx => {
        if (!this.definition.management.upgrade) throw new PluginError('Agent cannot upgrade')
        if (options.automatic && (!this.definition.management.supportsAutoUpdate || await this.definition.management.supportsAutoUpdate(ctx) !== true)) throw new PluginError('Automatic updates are no longer supported', 'AGENT_UNSUPPORTED', 400)
        const status = agentStatus(await this.definition.getStatus(ctx))
        if (status.version !== input.expectedVersion) throw new PluginError('Agent version changed; check updates again', 'AGENT_VERSION', 409)
        const update = agentUpdate(await this.definition.management.checkUpdate!(ctx))
        if (!update.updateAvailable || update.latestVersion !== input.version || update.currentVersion !== status.version) throw new PluginError('Agent update changed; check updates again', 'AGENT_VERSION', 409)
        await this.closeSessions()
        const result = agentUpgrade(await this.definition.management.upgrade(input, ctx))
        const actual = agentStatus(await this.definition.getStatus(ctx))
        if (!actual.installed || actual.version !== result.installedVersion || actual.version !== input.version) throw new PluginError('Agent upgrade did not install the requested version')
        return json(result)
      })
    } finally { this.updating = false }
  }
  async supportsAutoUpdate(identity: PluginIdentity): Promise<boolean> {
    if (!this.definition.management.supportsAutoUpdate) return false
    return this.manage(identity, undefined, async ctx => {
      const supported = await this.definition.management.supportsAutoUpdate!(ctx)
      if (typeof supported !== 'boolean') throw new PluginError('Invalid Agent automatic update capability')
      return supported
    })
  }
  async remove(identity: PluginIdentity, input: { expectedVersion: string }) {
    if (this.isBusyForUpdate()) throw new PluginError('Agent is busy; retry after its runs finish', 'AGENT_BUSY', 409)
    if (!input || typeof input.expectedVersion !== 'string') throw new PluginError('Expected version is required')
    this.updating = true
    try {
      return await this.manage(identity, undefined, async ctx => {
        if (!this.definition.management.remove) throw new PluginError('Agent cannot remove its engine', 'AGENT_UNSUPPORTED', 400)
        const before = agentStatus(await this.definition.getStatus(ctx))
        if (before.version !== input.expectedVersion) throw new PluginError('Agent version changed; refresh before removing', 'AGENT_VERSION', 409)
        await this.closeSessions()
        await this.definition.management.remove(ctx)
        const after = agentStatus(await this.definition.getStatus(ctx))
        if (after.installed) throw new PluginError('Agent engine is still installed')
        return { removed: true }
      })
    } finally { this.updating = false }
  }
  async execute(input: {
    identity: PluginIdentity & { sessionId: string; runId: string }; mode: AgentMode; paths: { runtimeDir: string; workspaceDir: string }
    request: AgentRunInput; model: AgentScopedModel | { model?: string; reasoningEffort?: string }
    signal: AbortSignal; deadlineAt: number; attachments: AgentRunContext['attachments']; emit(event: AgentEvent): Promise<void>
    mcpServers?: AgentRunContext['mcpServers']; interactions?: AgentRunContext['interactions']
  }): Promise<AgentRunResult> {
    if (this.updating) throw new PluginError('Agent is upgrading', 'AGENT_BUSY', 409)
    if (!this.definition.modes[input.mode]) throw new PluginError('Agent mode is unavailable')
    const identity = { ...input.identity, agentId: this.id }
    const key = JSON.stringify([identity.userId, identity.profile, identity.sessionId, input.mode])
    let entry = this.sessions.get(key)
    const store = this.owner.runContext(identity, input.signal).state.plugin.namespace('agent-runtime', this.definition.id, String(identity.userId), identity.profile, identity.sessionId, input.mode)
    if (!entry) {
      const effects = new PluginEffects()
      entry = { effects, engine: Promise.resolve(null as unknown as AgentSession), busy: false }
      this.sessions.set(key, entry)
      entry.engine = this.owner.withIdentity(identity, effects.controller.signal, async () => {
        await mkdir(input.paths.runtimeDir, { recursive: true, mode: 0o700 })
        const resumeState = this.definition.features.resume ? await store.get('checkpoint') : undefined
        let engine: AgentSession | undefined
        await effects.acquire(async () => {
          engine = await this.definition.runtime.createSession({ identity: Object.freeze(identity), mode: input.mode, paths: Object.freeze(input.paths),
            resumeState: resumeState as unknown as import('../../contracts/plugins').AgentCheckpoint | undefined,
            signal: effects.controller.signal, log: this.owner.context().log, lifecycle: { add: dispose => effects.add(dispose), acquire: acquire => effects.acquire(acquire) } })
          if (typeof engine?.run !== 'function' || typeof engine.dispose !== 'function' || this.definition.features.resume && typeof engine.checkpoint !== 'function') throw new PluginError('Invalid Agent session implementation')
          return () => engine!.dispose()
        })
        return engine!
      })
    }
    if (entry.busy) throw new PluginError('Agent session is already running', 'AGENT_BUSY', 409)
    entry.busy = true
    this.activity = ++activitySequence
    const current = entry
    const runEffects = new PluginEffects()
    try {
      return await this.owner.withIdentity(identity, AbortSignal.any([input.signal, current.effects.controller.signal]), async signal => {
        const engine = await current.engine
        signal.throwIfAborted()
        const base = this.owner.runContext(identity, signal)
        const context = { ...base, identity: Object.freeze(identity), paths: Object.freeze(input.paths),
          mode: input.mode, model: Object.freeze(input.model), signal, deadlineAt: input.deadlineAt,
          state: { ...base.state, agentSession: base.state.plugin.namespace('agent-runtime', this.definition.id, String(identity.userId), identity.profile, identity.sessionId, input.mode) },
          log: this.owner.context().log, lifecycle: { add: (dispose: () => void | Promise<void>) => runEffects.add(dispose), acquire: acquire => runEffects.acquire(acquire) },
          attachments: {
            resolve: async (assetId: string) => { signal.throwIfAborted(); await this.owner.ports.authorize(identity); return input.attachments.resolve(assetId) },
            read: async (assetId: string) => { signal.throwIfAborted(); await this.owner.ports.authorize(identity); return input.attachments.read(assetId) },
          }, mcpServers: Object.freeze(input.mcpServers || {}),
          interactions: {
            approve: async request => { signal.throwIfAborted(); await this.owner.ports.authorize(identity); if (!input.interactions) throw new PluginError('Agent interactions are unavailable'); return input.interactions.approve(request) },
            clarify: async request => { signal.throwIfAborted(); await this.owner.ports.authorize(identity); if (!input.interactions) throw new PluginError('Agent interactions are unavailable'); return input.interactions.clarify(request) },
          }, output: { emit: async (event: AgentEvent) => { signal.throwIfAborted(); await this.owner.ports.authorize(identity); await input.emit(agentEvent(event)) } },
        } as AgentRunContext
        const result = agentResult(await engine.run(input.request, context))
        signal.throwIfAborted()
        const checkpoint = result.checkpoint || (this.definition.features.resume ? await engine.checkpoint!() : undefined)
        signal.throwIfAborted()
        if (checkpoint) {
          await store.set('checkpoint', json(agentCheckpoint(checkpoint)))
        }
        return result
      })
    } catch (error) {
      this.sessions.delete(key)
      await closeEffects(current.effects)
      throw error
    } finally { current.busy = false; this.activity = ++activitySequence; await closeEffects(runEffects) }
  }
  async closeSessions() {
    const entries = [...this.sessions.values()]; this.sessions.clear()
    await Promise.allSettled(entries.map(entry => closeEffects(entry.effects)))
  }
  async closeSession(sessionId: string) {
    const entries: Entry[] = []
    for (const [key, entry] of this.sessions) if (JSON.parse(key)[2] === sessionId) { this.sessions.delete(key); entries.push(entry) }
    await Promise.allSettled(entries.map(entry => closeEffects(entry.effects)))
  }
}
