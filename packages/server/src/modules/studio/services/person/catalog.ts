import { FALLBACK_REASONING_EFFORTS, resolveModelReasoningEffort } from '../../../../../../shared/reasoning-effort'
import { findUserById, listUserProfiles, userCanAccessProfile } from '../../repositories/users-store'
import { getActiveProfileName, listProfileNamesFromDisk } from '../../public/profile-config'
import { getAgentAvailabilitySnapshot } from '../../public/agent-status-registry'
import { getSessionAvailableModelGroups } from '../../public/session-agent-runtime'
import { isScopedCodingAgentAuthProvider } from '../../contracts/provider-compat'
import { personRuntime } from '../../public/person-runtime'
import { resolveProviderCatalogApiMode } from '../../contracts/providers'
import { isAgentRuntime } from '../../contracts/agents/runtime'
import { personError } from '../../contracts/person'
import type { PersonSelection, PersonSettings } from '../../contracts/person'
import { personSettings } from '../../repositories/person-store'
import { readCompressionPolicy } from '../compression-policy'
import { getModelContextLength } from '../../public/provider-runtime'

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
export function personCapabilities(userId: number) {
  personUser(userId)
  return getAgentAvailabilitySnapshot().agents.map(a => ({
    runtime: a.id === 'ekko-agent' ? 'ekko' : a.id,
    installed: a.installed, status: a.installed ? 'requires_model_selection' : 'not_installed',
    controls: ['start', 'cancel', 'checkpoint_resume'], interaction: 'person',
  }))
}
function apiMode(group: any, model: string): string | undefined {
  return group.api_mode_by_model?.[model] || group.api_mode || resolveProviderCatalogApiMode(group.provider, model)
}

function personModelAllowed(group: any, model: string) {
  return group.provider !== 'moa' && !group.model_meta?.[model]?.disabled
    && !['bedrock_converse', 'codex_app_server'].includes(apiMode(group, model) || '')
}

/** UI catalog only: these groups never enter the model's context or expose credentials. */
export async function personModelCatalog(userId: number) {
  const groups = []
  for (const profile of personProfiles(userId)) {
    const catalog = await personRuntime().modelConfig(profile)
    for (const group of catalog.groups) {
      const models = group.models.filter(model => personModelAllowed(group, model))
      if (!models.length) continue
      groups.push({ profile, provider: group.provider, label: group.label || group.provider, models,
        model_meta: Object.fromEntries(models.map(model => [model, group.model_meta?.[model] || {}])) })
    }
  }
  return { groups }
}

export async function effectivePersonSettings(userId: number, stored = personSettings(userId)) {
  const profiles = personProfiles(userId)
  // Use Studio's global default resource, never the browser's current Profile header.
  const profile = stored.settings.model?.profile || getActiveProfileName() || 'default'
  const catalog = profiles.includes(profile) ? await personRuntime().modelConfig(profile) : null
  let model = stored.settings.model
  if (!model && catalog?.default) {
    const group = catalog.groups.find(group => (!catalog.default_provider || group.provider === catalog.default_provider)
      && group.models.includes(catalog.default) && personModelAllowed(group, catalog.default))
    if (group) model = { runtime: 'ekko', mode: 'scoped', profile, provider: group.provider, model: catalog.default, apiMode: apiMode(group, catalog.default) }
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

export async function personModelSelection(userId: number, input: Record<string, unknown>): Promise<PersonSelection> {
  const profile = String(input.profile || '')
  if (!personProfiles(userId).includes(profile)) throw personError('Execution resource is unavailable', 403)
  const provider = String(input.provider || '')
  const model = String(input.model || '')
  const group = (await personRuntime().modelConfig(profile)).groups.find(group => group.provider === provider && group.models.includes(model))
  if (!group || !personModelAllowed(group, model)) throw personError('Model unavailable or changed', 409)
  return { runtime: 'ekko', mode: 'scoped', profile, provider, model, apiMode: apiMode(group, model) }
}
export async function validatePersonSelection(userId: number, selection: PersonSelection) {
  const user = personUser(userId)
  if (!isAgentRuntime(selection.runtime) || !['global', 'scoped'].includes(selection.mode)) throw personError('Invalid runtime')
  if (!personProfiles(userId).includes(selection.profile) || (user.role !== 'super_admin' && !userCanAccessProfile(userId, selection.profile))) throw personError('Execution resource is unavailable', 403)
  const available = personCapabilities(userId).find(a => a.runtime === selection.runtime)
  if (!available?.installed) throw personError('Agent is not installed', 409)
  if (selection.mode === 'global') {
    if (user.role !== 'super_admin' || ['ekko', 'hermes'].includes(selection.runtime)) throw personError('Native machine credentials are not assigned to this account', 403)
    if (!selection.model && !selection.reasoningEffort) return // Delegate native defaults to the installed runtime.
    const result = await personRuntime().nativeModels(selection.runtime)
    const model = result.models.find(m => selection.model ? m.id === selection.model : m.isDefault)
    if (result.status !== 'ready' || !model) throw personError(`Native model unavailable: ${result.status}`, 409)
    if (selection.reasoningEffort && (model.reasoningEffort ? model.reasoningEffort !== selection.reasoningEffort
      : !model.reasoningEfforts?.includes(selection.reasoningEffort))) throw personError('Native model does not support this reasoning effort')
    return
  }
  if (!['ekko','hermes'].includes(selection.runtime) && isScopedCodingAgentAuthProvider(selection.provider)) throw personError('Use native mode for subscription providers', 409)
  const groups = await getSessionAvailableModelGroups(selection.profile)
  const group = groups.find(g => g.provider === selection.provider && g.models?.includes(selection.model))
  if (selection.runtime !== 'hermes' && ['bedrock_converse','codex_app_server'].includes(selection.apiMode || '')) throw personError('Runtime does not support this model protocol', 409)
  if (!group || group.model_meta?.[selection.model]?.disabled || apiMode(group, selection.model) !== selection.apiMode) throw personError('Model unavailable or changed', 409)
}
