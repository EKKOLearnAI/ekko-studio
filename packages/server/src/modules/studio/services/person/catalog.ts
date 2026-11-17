import { withProviderAccount } from '../../public/provider-account'
import { agentDescriptors, agentStatus, isPluginAgentId, agentDescriptor } from '../agents/registry'
import { FALLBACK_REASONING_EFFORTS, resolveModelReasoningEffort } from '../../../../../../shared/reasoning-effort'
import { findUserById, listUserProfiles, userCanAccessProfile, getDefaultProfileForUser } from '../../repositories/users-store'
import { getActiveProfileName, listProfileNamesFromDisk } from '../../public/profile-config'
import { getAgentAvailabilitySnapshot } from '../../public/agent-status-registry'
import { getSessionAvailableModelGroups } from '../../public/session-agent-runtime'
import { personRuntime } from '../../public/person-runtime'
import { resolveProviderCatalogApiMode } from '../../contracts/providers'
import { isAgentRuntime } from '../../contracts/agents/runtime'
import { personError } from '../../contracts/person'
import type { PersonSelection, PersonSettings } from '../../contracts/person'
import { personSettings } from '../../repositories/person-store'
import { readCompressionPolicy } from '../compression-policy'
import { getModelContextLength } from '../../public/provider-runtime'
import { logicalModelSelection } from '../../public/model-routing'

export const PERSON_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export function personUser(userId: number) {
  const user = findUserById(userId)
  if (!user || user.status !== 'active') throw personError('Account is unavailable', 403)
  return { id: user.id, username: user.username, role: user.role, profiles: listUserProfiles(user.id).map(p => p.profile_name) }
}
export function personProfiles(userId: number) {
  const user = personUser(userId)
  return listProfileNamesFromDisk().filter(p => user.role === 'super_admin' || user.profiles.includes(p)).sort()
}
async function personCapabilitiesImpl(userId: number, profile = getDefaultProfileForUser(userId) || 'default') {
  personUser(userId)
  const builtins = getAgentAvailabilitySnapshot().agents.map(a => ({
    runtime: a.id === 'ekko-agent' ? 'ekko' : a.id,
    installed: a.installed, status: a.installed ? 'requires_model_selection' : 'not_installed',
    controls: ['start', 'cancel', 'checkpoint_resume'], interaction: 'person',
  }))
  const plugins = await Promise.all(agentDescriptors().filter(a => a.origin === 'plugin' && a.surfaces.includes('chat')).map(async descriptor => {
    let installed = false
    try { installed = (await agentStatus(descriptor.id, { userId, profile, surface: 'ui' })).installed } catch { /* Unavailable plugins cannot receive tasks. */ }
    return { runtime: descriptor.id, installed, status: installed ? 'requires_model_selection' : 'not_installed',
      controls: ['start', 'cancel', 'checkpoint_resume'], interaction: 'person', descriptor }
  }))
  return [...builtins, ...plugins]
}
type PersonProtocolGroup = { provider: string; api_mode?: string; api_mode_by_model?: Record<string, string | null> }

function apiMode(group: PersonProtocolGroup, model: string): string | undefined {
  return group.api_mode_by_model?.[model] || group.api_mode || resolveProviderCatalogApiMode(group.provider, model)
}

const SELECTABLE_API_MODES = ['chat_completions', 'codex_responses', 'anthropic_messages']

export function personSelectionApiMode(group: PersonProtocolGroup, model: string, requested: unknown, runtime = 'ekko'): string | undefined {
  const configured = apiMode(group, model)
  if (requested === undefined) return configured
  if (runtime === 'hermes' && requested === configured) return configured
  if (typeof requested !== 'string' || !SELECTABLE_API_MODES.includes(requested)) throw personError('Unsupported model protocol')
  // Hermes also uses the HTTP gateway, so saved HTTP choices need not match
  // the current upstream protocol. Native-only protocols cannot be translated.
  if (['bedrock_converse', 'codex_app_server'].includes(configured || '')) {
    if (requested !== configured) throw personError('Runtime does not support this model protocol', 409)
  }
  return requested
}

function personModelAllowed(group: any, model: string) {
  return group.provider !== 'moa' && !group.model_meta?.[model]?.disabled
    && !['bedrock_converse', 'codex_app_server'].includes(apiMode(group, model) || '')
}

/** UI catalog only: these groups never enter the model's context or expose credentials. */
async function personModelCatalogImpl(userId: number) {
  const groups = []
  for (const profile of personProfiles(userId)) {
    const catalog = await personRuntime().modelConfig(profile)
    for (const group of catalog.groups) {
      const models = group.models.filter(model => personModelAllowed(group, model))
      if (!models.length) continue
      groups.push({ profile, provider: group.provider, label: group.label || group.provider, models,
        supports_gateway_auth: true,
        api_mode: group.api_mode, api_mode_by_model: group.api_mode_by_model,
        model_meta: Object.fromEntries(models.map(model => [model, group.model_meta?.[model] || {}])) })
    }
  }
  return { groups }
}

async function effectivePersonSettingsImpl(userId: number, stored = personSettings(userId)) {
  const profiles = personProfiles(userId)
  // Use Studio's global default resource, never the browser's current Profile header.
  const profile = stored.settings.model?.profile || getActiveProfileName() || 'default'
  const catalog = profiles.includes(profile) ? await personRuntime().modelConfig(profile) : null
  let model = stored.settings.model
  // Persisted selections and the inherited default may still contain Hermes'
  // gateway projection. Resolve it in this account before matching the catalog.
  if (model) model = { ...model, ...logicalModelSelection(profile, model.provider, model.model) }
  if (!model && catalog?.default) {
    const selected = logicalModelSelection(profile, catalog.default_provider, catalog.default)
    const group = catalog.groups.find(group => (!selected.provider || group.provider === selected.provider)
      && group.models.includes(selected.model) && personModelAllowed(group, selected.model))
    if (group) model = { runtime: 'ekko', mode: 'scoped', profile, provider: group.provider, model: selected.model, apiMode: apiMode(group, selected.model) }
  }
  const meta = model ? catalog?.groups.find(group => group.provider === model!.provider)?.model_meta?.[model.model] : undefined
  const reasoningEfforts = !model || meta?.reasoning === false ? []
    : [...PERSON_REASONING_EFFORTS].filter(effort => (meta?.reasoning_efforts ?? FALLBACK_REASONING_EFFORTS).includes(effort))
  const reasoningEffort = resolveModelReasoningEffort(stored.settings.reasoningEffort, { reasoning_efforts: reasoningEfforts }) || ''
  const policy = await readCompressionPolicy(profile)
  const contextTokens = model ? getModelContextLength({ profile: model.profile, provider: model.provider, model: model.model }) : 0
  return { revision: stored.revision, settings: { ...stored.settings, model, reasoningEffort } as PersonSettings,
    inherits_global_model: !stored.settings.model, reasoning_efforts: reasoningEfforts, contextTokens,
    compression: { enabled: policy.enabled, threshold: stored.settings.compressionThreshold ?? policy.threshold, globalThreshold: policy.threshold } }
}

async function personModelSelectionImpl(userId: number, input: Record<string, unknown>): Promise<PersonSelection> {
  const profile = String(input.profile || '')
  if (!personProfiles(userId).includes(profile)) throw personError('Execution resource is unavailable', 403)
  const provider = String(input.provider || '')
  const model = String(input.model || '')
  const group = (await personRuntime().modelConfig(profile)).groups.find(group => group.provider === provider && group.models.includes(model))
  if (!group || !personModelAllowed(group, model)) throw personError('Model unavailable or changed', 409)
  return { runtime: 'ekko', mode: 'scoped', profile, provider, model, apiMode: personSelectionApiMode(group, model, input.apiMode) }
}
async function validatePersonSelectionImpl(userId: number, selection: PersonSelection) {
  const user = personUser(userId)
  if (!isAgentRuntime(selection.runtime) || !['global', 'scoped'].includes(selection.mode)) throw personError('Invalid runtime')
  if (!personProfiles(userId).includes(selection.profile) || (user.role !== 'super_admin' && !userCanAccessProfile(userId, selection.profile))) throw personError('Execution resource is unavailable', 403)
  const available = (await personCapabilities(userId, selection.profile)).find(a => a.runtime === selection.runtime)
  if (!available?.installed) throw personError('Agent is not installed', 409)
  const plugin = isPluginAgentId(selection.runtime) ? agentDescriptor(selection.runtime) : undefined
  if (plugin && !plugin.modes.includes(selection.mode)) throw personError('Agent does not support this mode', 409)
  if (selection.mode === 'global') {
    if ((!plugin && user.role !== 'super_admin') || ['ekko', 'hermes'].includes(selection.runtime)) throw personError('Native machine credentials are not assigned to this account', 403)
    if (!selection.model && !selection.reasoningEffort) return // Delegate native defaults to the installed runtime.
    const result = await personRuntime().nativeModels(selection.runtime, { userId, profile: selection.profile })
    const model = result.models.find(m => selection.model ? m.id === selection.model : m.isDefault)
    if (result.status !== 'ready' || !model) throw personError(`Native model unavailable: ${result.status}`, 409)
    if (selection.reasoningEffort && (model.reasoningEffort ? model.reasoningEffort !== selection.reasoningEffort
      : !model.reasoningEfforts?.includes(selection.reasoningEffort))) throw personError('Native model does not support this reasoning effort')
    return
  }
  const groups = await getSessionAvailableModelGroups(selection.profile)
  const group = groups.find(g => g.provider === selection.provider && g.models?.includes(selection.model))
  if (selection.runtime !== 'hermes' && ['bedrock_converse','codex_app_server'].includes(selection.apiMode || '')) throw personError('Runtime does not support this model protocol', 409)
  if (!group || group.model_meta?.[selection.model]?.disabled) throw personError('Model unavailable or changed', 409)
  if (personSelectionApiMode(group, selection.model, selection.apiMode, selection.runtime) !== selection.apiMode) throw personError('Model unavailable or changed', 409)
}

export const personCapabilities = (...args: Parameters<typeof personCapabilitiesImpl>) => withProviderAccount(args[0], () => personCapabilitiesImpl(...args))

export const personModelCatalog = (...args: Parameters<typeof personModelCatalogImpl>) => withProviderAccount(args[0], () => personModelCatalogImpl(...args))

export const effectivePersonSettings = (...args: Parameters<typeof effectivePersonSettingsImpl>) => withProviderAccount(args[0], () => effectivePersonSettingsImpl(...args))

export const personModelSelection = (...args: Parameters<typeof personModelSelectionImpl>) => withProviderAccount(args[0], () => personModelSelectionImpl(...args))

export const validatePersonSelection = (...args: Parameters<typeof validatePersonSelectionImpl>) => withProviderAccount(args[0], () => validatePersonSelectionImpl(...args))
