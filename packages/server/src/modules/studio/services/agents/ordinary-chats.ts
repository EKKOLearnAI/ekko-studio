import { isAbsolute, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { StudioError, type ExecutionScope, type JsonObject } from '../../contracts/plugins'
import type { AgentRegistry } from './registry'
import type { AgentCoordinator } from './coordinator'
import type { AgentChats, AgentChatSessionCreation } from './chats'
import type { OrdinaryAgentChatStore } from '../../repositories/ordinary-agent-chat-store'
import { jsonCopy } from '../plugins/validation'

export interface OrdinaryAgentSelection extends JsonObject {
  sessionId: string; agentTypeId: string; mode: 'scoped' | 'global'
  workspace: string; model: string; provider: string; reasoningEffort: string; agentPreset: string
  categoryId: number | null; pushEnabled: boolean
  baseUrl: string; apiKey: string; apiMode: string
}

/** Application adapter for the existing Agent → global/model chat flow. */
export class OrdinaryAgentChats {
  constructor(private readonly deps: {
    store: OrdinaryAgentChatStore; registry: AgentRegistry; coordinator: AgentCoordinator; chats: AgentChats
    authorize(scope: ExecutionScope): void
    ensure(scope: ExecutionScope, id: string): Promise<void>
    prepare(scope: ExecutionScope, selection: OrdinaryAgentSelection): Promise<JsonObject>
    defaultWorkspace(profileId: string, provider: string): string
    updateSession(id: string, settings: Partial<AgentChatSessionCreation>): void
  }) {}

  private check(scope: ExecutionScope): void {
    this.deps.authorize(scope)
    if (scope.principal.kind !== 'user' || scope.sessionId !== undefined || scope.runId !== undefined || scope.workspaceId !== undefined) throw new StudioError('FORBIDDEN', 'New chats require an unbound user scope')
  }

  private parse(value: JsonObject): OrdinaryAgentSelection {
    const input = jsonCopy(value)
    const keys = ['sessionId', 'agentTypeId', 'mode', 'workspace', 'model', 'provider', 'reasoningEffort', 'agentPreset', 'categoryId', 'pushEnabled', 'baseUrl', 'apiKey', 'apiMode']
    if (!input || Object.keys(input).some(key => !keys.includes(key)) || typeof input.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.sessionId)
      || typeof input.agentTypeId !== 'string' || !input.agentTypeId || input.agentTypeId.length > 128 || !['global', 'scoped'].includes(String(input.mode))) throw new StudioError('INVALID_ARGUMENT', 'Invalid chat selection')
    for (const key of ['workspace', 'model', 'provider', 'reasoningEffort', 'agentPreset', 'baseUrl', 'apiKey', 'apiMode']) {
      if (input[key] !== undefined && (typeof input[key] !== 'string' || String(input[key]).includes('\0') || String(input[key]).length > (['baseUrl', 'apiKey'].includes(key) ? 8192 : key === 'workspace' ? 4096 : 256))) throw new StudioError('INVALID_ARGUMENT', 'Invalid chat setting')
    }
    if (input.categoryId != null && (!Number.isSafeInteger(input.categoryId) || Number(input.categoryId) < 1)
      || input.pushEnabled !== undefined && typeof input.pushEnabled !== 'boolean') throw new StudioError('INVALID_ARGUMENT', 'Invalid chat setting')
    const workspace = String(input.workspace || '').trim()
    if (workspace && !isAbsolute(workspace)) throw new StudioError('INVALID_ARGUMENT', 'Workspace must be absolute')
    const baseUrl = String(input.baseUrl || '').trim(), apiKey = String(input.apiKey || '').trim(), apiMode = String(input.apiMode || '').trim()
    if (baseUrl) {
      let url: URL
      try { url = new URL(baseUrl) } catch { throw new StudioError('INVALID_ARGUMENT', 'Invalid model base URL') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new StudioError('INVALID_ARGUMENT', 'Invalid model base URL')
    }
    if (apiMode && !['chat_completions', 'codex_responses', 'anthropic_messages'].includes(apiMode)
      || input.mode === 'global' && (baseUrl || apiKey || apiMode)) throw new StudioError('INVALID_ARGUMENT', 'Invalid model connection')
    return { sessionId: input.sessionId, agentTypeId: input.agentTypeId, mode: input.mode as OrdinaryAgentSelection['mode'], workspace,
      model: String(input.model || '').trim(), provider: String(input.provider || '').trim(), reasoningEffort: String(input.reasoningEffort || '').trim(), agentPreset: String(input.agentPreset || '').trim(),
      categoryId: input.categoryId as number ?? null, pushEnabled: input.pushEnabled !== false, baseUrl, apiKey, apiMode }
  }

  private async configuration(scope: ExecutionScope, selection: OrdinaryAgentSelection) {
    this.check(scope)
    await this.deps.ensure(scope, selection.agentTypeId)
    this.check(scope)
    const { definition, provider } = this.deps.registry.resolve(scope.profileId, selection.agentTypeId)
    if (provider.kind !== 'plugin' || !definition.capabilities.modes.includes(selection.mode)) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Agent does not support this chat mode')
    const config = await this.deps.prepare(scope, selection)
    this.check(scope)
    config.cwd = resolve(selection.workspace || this.deps.defaultWorkspace(scope.profileId, selection.mode === 'global' ? 'global' : selection.provider))
    const properties = typeof definition.configSchema === 'object' ? definition.configSchema.properties as JsonObject | undefined : undefined
    if (selection.reasoningEffort) {
      const key = properties?.reasoningEffort ? 'reasoningEffort' : properties?.effort ? 'effort' : undefined
      if (key) config[key] = selection.reasoningEffort
      else if (selection.mode !== 'global') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Agent does not expose a reasoning setting')
    }
    if (selection.agentPreset) config.agentPreset = selection.agentPreset
    await mkdir(String(config.cwd), { recursive: true })
    this.check(scope)
    return config
  }

  private settings(selection: OrdinaryAgentSelection) {
    return { model: selection.model, provider: selection.mode === 'global' ? '' : selection.provider, reasoning_effort: selection.reasoningEffort,
      agent_preset: selection.agentPreset, category_id: selection.categoryId, push_enabled: selection.pushEnabled }
  }

  async create(inputScope: ExecutionScope, value: JsonObject) {
    const scope = jsonCopy(inputScope), selection = this.parse(value)
    this.check(scope)
    const previous = this.deps.store.previous(scope, selection.sessionId, selection)
    if (previous) { this.deps.chats.ownedBinding(scope, previous.sessionId); return previous }
    const config = await this.configuration(scope, selection)
    const receipt = this.deps.store.create(scope, selection.sessionId, selection, () => {
      this.check(scope)
      const instance = this.deps.coordinator.createInstance(scope, { agentTypeId: selection.agentTypeId, config, mode: selection.mode })
      return this.deps.chats.create(scope, instance.id, { revision: instance.revision, idempotencyKey: `draft:${createHash('sha256').update(selection.sessionId).digest('hex')}` },
        { id: selection.sessionId, settings: this.settings(selection) })
    })
    this.deps.chats.ownedBinding(scope, receipt.sessionId)
    return receipt
  }

  isOrdinary(sessionId: string): boolean { return !!this.deps.store.selection(sessionId) }

  async update(scope: ExecutionScope, id: string, patch: JsonObject) {
    this.check(scope)
    const { instance } = this.deps.chats.ownedBinding(scope, id)
    const saved = this.deps.store.selection(id)
    if (!saved) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Chat configuration is owned by its Agent instance')
    if (Object.keys(patch).some(key => !['workspace', 'model', 'provider', 'reasoningEffort'].includes(key))) throw new StudioError('INVALID_ARGUMENT', 'Invalid chat settings')
    const selection = this.parse({ ...saved, ...patch, ...('provider' in patch || 'model' in patch ? { baseUrl: '', apiKey: '', apiMode: '' } : {}) }), config = await this.configuration(scope, selection)
    return this.deps.coordinator.updateInstance(scope, instance.id, { revision: instance.revision, config, mode: instance.mode }, () => {
      this.check(scope)
      this.deps.chats.ownedBinding(scope, id)
      this.deps.store.update(id, selection)
      this.deps.updateSession(id, { ...this.settings(selection), workspace: String(config.cwd) })
    })
  }
}
