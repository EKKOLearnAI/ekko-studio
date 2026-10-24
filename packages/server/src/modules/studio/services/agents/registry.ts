import { StudioError, type AgentProviderRef, type AgentTypeDefinition, type AgentTypeSummary, type Disposer } from '../../contracts/plugins'
import { compileSchema, jsonCopy, parseAgentInspection, validateAgentDefinition } from '../plugins/validation'

interface Entry { profileId: string; provider: AgentProviderRef; definition: AgentTypeDefinition; summary: AgentTypeSummary; token: object }

const owner = (provider: AgentProviderRef): string => provider.kind === 'builtin' ? `builtin:${provider.module}` : `plugin:${provider.pluginId}`

export class AgentRegistry {
  private readonly entries = new Map<string, Entry>()
  private revision = 0

  getRevision(): number { return this.revision }

  list(profileId: string): AgentTypeSummary[] {
    return [...this.entries.values()].filter(entry => entry.profileId === '*' || entry.profileId === profileId)
      .map(entry => jsonCopy(entry.summary)).sort((a, b) => a.id.localeCompare(b.id))
  }

  resolve(profileId: string, id: string): { definition: AgentTypeDefinition; provider: AgentProviderRef } {
    const entry = this.entries.get(`${profileId}:${id}`) || this.entries.get(`*:${id}`)
    if (!entry) throw new StudioError('RUNTIME_UNAVAILABLE', 'Agent type is not available in this profile')
    return { definition: entry.definition, provider: jsonCopy(entry.provider) }
  }

  stage(profileId: string, providerInput: AgentProviderRef, allowedIds: readonly string[]) {
    const provider = jsonCopy(providerInput)
    if (!profileId || (profileId === '*' && provider.kind === 'plugin')) throw new StudioError('FORBIDDEN', 'Plugins require a concrete profile scope')
    const token = {}
    const pending = new Map<string, Entry>()
    let state: 'staging' | 'committed' | 'disposed' = 'staging'
    const revoke = (id: string): void => {
      pending.delete(id)
      const key = `${profileId}:${id}`
      if (this.entries.get(key)?.token === token) { this.entries.delete(key); this.revision++ }
    }
    const validate = (): void => {
      if (state !== 'staging') throw new StudioError('PLUGIN_UNAVAILABLE', 'Registration is no longer pending')
      if (pending.size !== allowedIds.length) throw new StudioError('INVALID_ARGUMENT', 'Plugin did not register every declared Agent type')
      for (const entry of pending.values()) {
        for (const existing of this.entries.values()) {
          if (existing.definition.id !== entry.definition.id) continue
          if (existing.profileId !== profileId && existing.profileId !== '*' && profileId !== '*') continue
          if (owner(existing.provider) !== owner(provider)) throw new StudioError('REGISTRATION_CONFLICT', 'Agent type already belongs to another provider')
        }
      }
    }
    return {
      validate,
      register: (definition: AgentTypeDefinition): Disposer => {
        if (state !== 'staging') throw new StudioError('PLUGIN_UNAVAILABLE', 'Agent registration is only allowed during activation')
        validateAgentDefinition(definition)
        if (!allowedIds.includes(definition.id)) throw new StudioError('FORBIDDEN', 'Agent type was not declared by this provider')
        if (pending.has(definition.id)) throw new StudioError('REGISTRATION_CONFLICT', 'Duplicate Agent type')
        const summary: AgentTypeSummary = jsonCopy({
          id: definition.id, name: definition.name,
          ...(definition.description === undefined ? {} : { description: definition.description }),
          configSchema: definition.configSchema, capabilities: definition.capabilities, provider,
          ...(definition.management ? { management: { inspect: true } } : {}),
        })
        const validateConfig = compileSchema(summary.configSchema)
        const factory = definition.create
        const inspector = definition.management?.inspect
        const { management: _management, ...metadata } = jsonCopy(summary)
        const check = (input: { config: import('../../contracts/plugins').JsonObject; mode: 'scoped' | 'global' }, context: { profileId: string }) => {
          validateConfig(input.config)
          if (!summary.capabilities.modes.includes(input.mode)) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Agent does not support the requested mode')
          if (profileId !== '*' && context.profileId !== profileId) throw new StudioError('FORBIDDEN', 'Runtime profile does not match its registration')
        }
        const captured: AgentTypeDefinition = { ...metadata, ...(inspector ? { management: { inspect: async (input, context) => {
          check(input, context)
          return parseAgentInspection(await inspector(jsonCopy(input), context))
        } } } : {}), create: async (input, context) => {
          check(input, context)
          return factory(jsonCopy(input), context)
        } }
        pending.set(definition.id, { profileId, provider, definition: captured, summary, token })
        let disposed = false
        return () => { if (!disposed) { disposed = true; revoke(definition.id) } }
      },
      commit: (): void => {
        validate()
        for (const [id, entry] of pending) this.entries.set(`${profileId}:${id}`, entry)
        state = 'committed'
        this.revision++
      },
      dispose: (): void => {
        if (state === 'disposed') return
        state = 'disposed'
        for (const id of [...pending.keys()]) revoke(id)
      },
    }
  }
}
