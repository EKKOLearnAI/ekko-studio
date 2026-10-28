import { personError, personText } from '../../contracts/person'
import type { PersonAgentPreset, PersonSelection } from '../../contracts/person'
import { personSettings } from '../../repositories/person-store'
import { getSessionAvailableModelGroups } from '../../public/session-agent-runtime'
import { personProfiles, validatePersonSelection, PERSON_REASONING_EFFORTS } from './catalog'
import { isGlobalOnlyCodingAgent } from '../../contracts/agents/native-coding-agents'
import { resolveProviderCatalogApiMode } from '../../contracts/providers'

export async function validatePersonAgents(userId: number, value: unknown): Promise<PersonAgentPreset[]> {
  if (!Array.isArray(value) || value.length > 20) throw personError('Use at most 20 execution agents')
  const ids = new Set<string>()
  const result: PersonAgentPreset[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || !raw.selection) throw personError('Invalid execution agent')
    const id = personText(raw.id, 'agent id', 100)
    if (ids.has(id) || id === 'default') throw personError('Duplicate or reserved agent ID')
    ids.add(id)
    const input = raw.selection
    const selection: PersonSelection = { runtime: personText(input.runtime, 'runtime', 40), mode: input.mode,
      profile: personText(input.profile, 'profile', 100), provider: String(input.provider || ''),
      model: input.mode === 'global' && input.model === '' ? '' : personText(input.model, 'model', 300), reasoningEffort: String(input.reasoningEffort || '') }
    if (isGlobalOnlyCodingAgent(selection.runtime) && selection.mode !== 'global') throw personError('This agent requires native mode')
    if (!personProfiles(userId).includes(selection.profile)) throw personError('Execution resource is unavailable', 403)
    if (selection.mode === 'scoped') {
      const group = (await getSessionAvailableModelGroups(selection.profile)).find(g => g.provider === selection.provider && g.models?.includes(selection.model))
      if (!group) throw personError('Model unavailable', 409)
      selection.apiMode = group.api_mode_by_model?.[selection.model] || group.api_mode || resolveProviderCatalogApiMode(group.provider, selection.model)
      const meta = group.model_meta?.[selection.model]
      const efforts: readonly string[] = meta?.reasoning === false ? [] : meta?.reasoning_efforts || PERSON_REASONING_EFFORTS
      if (selection.reasoningEffort && !efforts.includes(selection.reasoningEffort)) throw personError('Model does not support this reasoning effort')
    }
    await validatePersonSelection(userId, selection)
    result.push({ id, name: personText(raw.name, 'agent name', 100), description: personText(raw.description, 'agent purpose', 1000), selection })
  }
  return result
}

export async function personExecutionAgents(userId: number): Promise<PersonAgentPreset[]> {
  return personSettings(userId).settings.agents
}
export function requirePersonAgents(userId: number): PersonAgentPreset[] {
  const agents = personSettings(userId).settings.agents
  if (!agents.length) throw personError('Configure at least one Agent preset in Person settings before chatting', 409)
  return agents
}
export async function selectPersonExecutionAgent(userId: number, id?: unknown) {
  const agents = requirePersonAgents(userId)
  const preset = id ? agents.find(agent => agent.id === id) : agents.length === 1 ? agents[0] : undefined
  if (!preset) throw personError('Choose one of the configured execution agents')
  await validatePersonSelection(userId, preset.selection)
  return preset.selection
}

/** Full model data is returned only to the settings UI, never to the Person prompt. */
export async function personExecutionModelCatalog(userId: number) {
  const groups = []
  const profiles = personProfiles(userId)
  for (const profile of profiles) for (const group of await getSessionAvailableModelGroups(profile)) {
    groups.push({ profile, provider: group.provider, label: group.label || group.provider,
      models: (group.models || []).filter((model: string) => !group.model_meta?.[model]?.disabled),
      model_meta: group.model_meta || {}, api_mode: group.api_mode, api_mode_by_model: group.api_mode_by_model })
  }
  return { groups, profiles }
}
