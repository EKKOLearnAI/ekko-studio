import { readConfigYamlForProfile } from '../../public/provider-config'
import { logicalModelSelection } from '../../public/model-routing'

export type RunModelGroup = { provider: string; models: string[]; model_meta?: Record<string, { reasoning?: boolean; reasoning_efforts?: string[] }> }

async function resolveDefaultModelConfig(profile: string): Promise<{ model: string; provider: string }> {
  try {
    const config = await readConfigYamlForProfile(profile)
    const modelConfig = config?.model
    const model = typeof modelConfig === 'string'
      ? modelConfig.trim()
      : String(modelConfig?.default || '').trim()
    const provider = typeof modelConfig === 'object'
      ? String(modelConfig?.provider || '').trim()
      : ''
    return logicalModelSelection(profile, provider, model)
  } catch {
    return { model: '', provider: '' }
  }
}

function hasModelInGroups(groups: RunModelGroup[] | undefined, provider: string, model: string): boolean {
  if (!groups?.length || !provider || !model) return false
  const group = groups.find(item => item.provider === provider)
  return Array.isArray(group?.models) && group.models.includes(model)
}

function isVirtualProvider(provider: string): boolean {
  return provider === 'moa'
}

export async function resolveBridgeRunModelConfig(options: {
  profile: string
  sessionModel?: string | null
  sessionProvider?: string | null
  requestedModel?: string | null
  requestedProvider?: string | null
  modelGroups?: RunModelGroup[]
  preferRequested?: boolean
}): Promise<{ model: string; provider: string }> {
  const sessionModel = String(options.sessionModel || '').trim()
  const sessionProvider = String(options.sessionProvider || '').trim()
  const requestedModel = String(options.requestedModel || '').trim()
  const requestedProvider = String(options.requestedProvider || '').trim()
  const candidate = logicalModelSelection(options.profile,
    options.preferRequested ? (requestedProvider || sessionProvider) : (sessionProvider || requestedProvider),
    options.preferRequested ? (requestedModel || sessionModel) : (sessionModel || requestedModel))
  const candidateModel = candidate.model
  const candidateProvider = candidate.provider
  const hasGroups = Array.isArray(options.modelGroups) && options.modelGroups.length > 0
  const candidateAvailable = hasGroups && hasModelInGroups(options.modelGroups, candidateProvider, candidateModel)
  const shouldUseDefault = !candidateModel || !candidateProvider || (hasGroups && !candidateAvailable && !isVirtualProvider(candidateProvider))
  const selected = shouldUseDefault
    ? await resolveDefaultModelConfig(options.profile)
    : { model: candidateModel, provider: candidateProvider }
  return selected
}
