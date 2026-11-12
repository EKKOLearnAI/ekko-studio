import { mkdir } from 'node:fs/promises'
import type { AgentDefinition, AgentEvent, AgentManagementContext, AgentMode, AgentRunContext, AgentRunInput, AgentRunResult, AgentScopedModel, AgentSession, PluginIdentity } from '../../contracts/plugins'
import { PluginEffects } from './effects'
import { PluginError } from './errors'
import { identifier, json } from './schema'
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
  for (const key of ['settings', 'checkUpdate', 'upgrade'] as const) if (definition.management[key] !== undefined && typeof definition.management[key] !== 'function') throw new PluginError(`Invalid Agent ${key} handler`)
  if (definition.management.upgrade && !definition.management.checkUpdate) throw new PluginError('Agent upgrade requires checkUpdate')
  const modes = definition.modes
  if (!modes || !modes.global && !modes.scoped || Object.keys(modes).some(key => !['global', 'scoped'].includes(key))) throw new PluginError('Agent must declare scoped or global mode')
  if (modes.global && typeof modes.global.listModels !== 'function') throw new PluginError('Global Agent requires listModels')
  if (modes.scoped && (!Array.isArray(modes.scoped.protocols) || !modes.scoped.protocols.length || modes.scoped.protocols.some(value => !['chat_completions', 'codex_responses', 'anthropic_messages'].includes(value)))) throw new PluginError('Scoped Agent requires supported protocols')
  const capabilities = definition.capabilities
  if (!capabilities || !Array.isArray(capabilities.surfaces) || !capabilities.surfaces.length || capabilities.surfaces.some(value => !['chat', 'group-chat', 'workflow', 'api'].includes(value)) || typeof capabilities.streaming !== 'boolean' || typeof capabilities.resume !== 'boolean') throw new PluginError('Invalid Agent capabilities')
  if ('images' in capabilities || 'files' in capabilities || 'supportsImages' in capabilities || 'supportsFiles' in capabilities) throw new PluginError('Images and files are required Agent inputs, not optional capabilities')
}

type Entry = { effects: PluginEffects; engine: Promise<AgentSession>; busy: boolean }
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
  constructor(readonly owner: PluginRuntime, readonly definition: AgentDefinition) {
    validateAgent(definition)
    this.id = pluginAgentId(owner.record.manifest.id, definition.id)
  }
  descriptor() {
    const d = this.definition
    return { id: this.id, pluginId: this.owner.record.manifest.id, name: d.name, vendor: d.vendor, description: d.description || '',
      icon: d.icon || this.owner.record.manifest.icon || '', origin: 'plugin' as const,
      modes: Object.keys(d.modes) as AgentMode[], surfaces: d.capabilities.surfaces,
      actions: { settings: !!d.management.settings, checkUpdate: !!d.management.checkUpdate, upgrade: !!d.management.upgrade } }
  }
  async manage<T>(identity: PluginIdentity, signal: AbortSignal | undefined, work: (ctx: AgentManagementContext) => Promise<T> | T): Promise<T> {
    const effects = new PluginEffects()
    try {
      return await this.owner.withIdentity(identity, AbortSignal.any([effects.controller.signal, AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]), async bound => work({
        identity: Object.freeze({ ...identity, agentId: this.id }), signal: bound,
        log: this.owner.context().log, resources: { add: dispose => effects.add(dispose) },
        progress: value => { this.owner.context().log.info(value.message) },
      }))
    } finally { await closeEffects(effects) }
  }
  status(identity: PluginIdentity, signal?: AbortSignal) {
    return this.manage(identity, signal, async ctx => {
      const value = json(await this.definition.getStatus(ctx)) as unknown as Awaited<ReturnType<AgentDefinition['getStatus']>>
      if (typeof value?.installed !== 'boolean' || typeof value.version !== 'string') throw new PluginError('Invalid Agent status')
      return value
    })
  }
  async models(identity: PluginIdentity, refresh = false, signal?: AbortSignal) {
    return this.manage(identity, signal, async ctx => {
      if (!this.definition.modes.global) throw new PluginError('Agent does not support global mode')
      const value = json(await this.definition.modes.global.listModels({ ...ctx, refresh })) as unknown as Awaited<ReturnType<NonNullable<AgentDefinition['modes']['global']>['listModels']>>
      if (!value || !Array.isArray(value.models) || value.models.some(m => !m || typeof m.id !== 'string' || !m.id || typeof m.name !== 'string')) throw new PluginError('Invalid Agent model catalog')
      return value
    })
  }
  async settings(identity: PluginIdentity) {
    return this.manage(identity, undefined, async ctx => {
      if (!this.definition.management.settings) throw new PluginError('Agent has no settings page')
      const target = json(await this.definition.management.settings(ctx)) as unknown as { viewId: string; query?: Record<string, string> }
      if (!this.owner.record.manifest.views?.some(view => view.id === target.viewId && view.slot === 'settings') || target.query && (typeof target.query !== 'object' || Object.values(target.query).some(value => typeof value !== 'string'))) throw new PluginError('Agent settings must target its own declared settings view')
      return { name: 'studio.pluginSettings', params: { pluginId: this.owner.record.manifest.id, viewId: target.viewId }, query: target.query || {} }
    })
  }
  async checkUpdate(identity: PluginIdentity) {
    return this.manage(identity, undefined, async ctx => {
      if (!this.definition.management.checkUpdate) throw new PluginError('Agent cannot check updates')
      const value = json(await this.definition.management.checkUpdate(ctx)) as unknown as Awaited<ReturnType<NonNullable<AgentDefinition['management']['checkUpdate']>>>
      if (typeof value?.currentVersion !== 'string' || typeof value.latestVersion !== 'string' || typeof value.updateAvailable !== 'boolean') throw new PluginError('Invalid Agent update result')
      return value
    })
  }
  async upgrade(identity: PluginIdentity, input: { version: string; expectedVersion: string }) {
    if (this.updating || [...this.sessions.values()].some(entry => entry.busy)) throw new PluginError('Agent is busy; retry after its runs finish', 'AGENT_BUSY', 409)
    if (!input || typeof input.version !== 'string' || !input.version.trim() || typeof input.expectedVersion !== 'string') throw new PluginError('Exact target and expected versions are required')
    this.updating = true
    try {
      return await this.manage(identity, undefined, async ctx => {
        if (!this.definition.management.upgrade) throw new PluginError('Agent cannot upgrade')
        const status = await this.definition.getStatus(ctx)
        if (status.version !== input.expectedVersion) throw new PluginError('Agent version changed; check updates again', 'AGENT_VERSION', 409)
        const update = await this.definition.management.checkUpdate!(ctx)
        if (!update.updateAvailable || update.latestVersion !== input.version || update.currentVersion !== status.version) throw new PluginError('Agent update changed; check updates again', 'AGENT_VERSION', 409)
        await this.closeSessions()
        const result = await this.definition.management.upgrade(input, ctx)
        const actual = await this.definition.getStatus(ctx)
        if (!actual.installed || actual.version !== result.installedVersion || actual.version !== input.version) throw new PluginError('Agent upgrade did not install the requested version')
        return json(result)
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
    const store = this.owner.runContext(identity, input.signal).storage.namespace('agent-runtime', this.definition.id, String(identity.userId), identity.profile, identity.sessionId, input.mode)
    if (!entry) {
      const effects = new PluginEffects()
      entry = { effects, engine: Promise.resolve(null as unknown as AgentSession), busy: false }
      this.sessions.set(key, entry)
      entry.engine = this.owner.withIdentity(identity, effects.controller.signal, async () => {
        await mkdir(input.paths.runtimeDir, { recursive: true, mode: 0o700 })
        const resumeState = this.definition.capabilities.resume ? await store.get('checkpoint') : undefined
        let engine: AgentSession | undefined
        await effects.acquire(async () => {
          engine = await this.definition.runtime.createSession({ identity: Object.freeze(identity), mode: input.mode, paths: Object.freeze(input.paths),
            resumeState: resumeState as unknown as import('../../contracts/plugins').AgentCheckpoint | undefined,
            signal: effects.controller.signal, log: this.owner.context().log, resources: { add: dispose => effects.add(dispose) } })
          if (typeof engine?.run !== 'function' || typeof engine.dispose !== 'function' || this.definition.capabilities.resume && typeof engine.checkpoint !== 'function') throw new PluginError('Invalid Agent session implementation')
          return () => engine!.dispose()
        })
        return engine!
      })
    }
    if (entry.busy) throw new PluginError('Agent session is already running', 'AGENT_BUSY', 409)
    entry.busy = true
    const current = entry
    const runEffects = new PluginEffects()
    try {
      return await this.owner.withIdentity(identity, AbortSignal.any([input.signal, current.effects.controller.signal]), async signal => {
        const engine = await current.engine
        signal.throwIfAborted()
        const base = this.owner.runContext(identity, signal)
        const context = { ...base, identity: Object.freeze(identity), paths: Object.freeze(input.paths),
          mode: input.mode, model: Object.freeze(input.model), signal, deadlineAt: input.deadlineAt,
          storage: base.storage.namespace('agent-runtime', this.definition.id, String(identity.userId), identity.profile, identity.sessionId, input.mode),
          log: this.owner.context().log, resources: { add: (dispose: () => void | Promise<void>) => runEffects.add(dispose) },
          attachments: {
            resolve: async (assetId: string) => { signal.throwIfAborted(); await this.owner.ports.authorize(identity); return input.attachments.resolve(assetId) },
            read: async (assetId: string) => { signal.throwIfAborted(); await this.owner.ports.authorize(identity); return input.attachments.read(assetId) },
          }, mcpServers: Object.freeze(input.mcpServers || {}),
          interactions: {
            approve: async request => { signal.throwIfAborted(); await this.owner.ports.authorize(identity); if (!input.interactions) throw new PluginError('Agent interactions are unavailable'); return input.interactions.approve(request) },
            clarify: async request => { signal.throwIfAborted(); await this.owner.ports.authorize(identity); if (!input.interactions) throw new PluginError('Agent interactions are unavailable'); return input.interactions.clarify(request) },
          }, events: { emit: async (event: AgentEvent) => { signal.throwIfAborted(); await this.owner.ports.authorize(identity); await input.emit(json(event) as unknown as AgentEvent) } },
        } as AgentRunContext
        const result = json(await engine.run(input.request, context)) as unknown as AgentRunResult
        signal.throwIfAborted()
        if (!result || !Array.isArray(result.content) || result.content.some(part => !part || !['text', 'image', 'file'].includes(part.type) || part.type === 'text' && typeof part.text !== 'string') || !['stop', 'length', 'tool_limit'].includes(result.finishReason)) throw new PluginError('Invalid Agent run result')
        if (result.usage && (typeof result.usage.isEstimated !== 'boolean' || ['inputTokens', 'outputTokens', 'cacheReadTokens', 'costUsd'].some(key => {
          const value = (result.usage as any)[key]
          return value != null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        }))) throw new PluginError('Invalid Agent usage')
        const checkpoint = result.checkpoint || (this.definition.capabilities.resume ? await engine.checkpoint!() : undefined)
        signal.throwIfAborted()
        if (checkpoint) {
          if (!Number.isSafeInteger(checkpoint.schemaVersion) || checkpoint.schemaVersion < 1) throw new PluginError('Invalid Agent checkpoint version')
          await store.set('checkpoint', json(checkpoint))
        }
        return result
      })
    } catch (error) {
      this.sessions.delete(key)
      await closeEffects(current.effects)
      throw error
    } finally { current.busy = false; await closeEffects(runEffects) }
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
