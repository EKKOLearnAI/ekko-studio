import { readConfigYamlForProfile } from '../../public/profile-config'

export type RunModelGroup = { provider: string; models: string[] }

function runtimeProvider(provider: string): string {
  return provider === 'claude-oauth' ? 'anthropic' : provider
}

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
    return { model, provider }
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
  preserveAuthorizedProvider?: boolean
}): Promise<{ model: string; provider: string }> {
  const sessionModel = String(options.sessionModel || '').trim()
  const sessionProvider = String(options.sessionProvider || '').trim()
  const requestedModel = String(options.requestedModel || '').trim()
  const requestedProvider = String(options.requestedProvider || '').trim()
  const candidateModel = options.preferRequested ? (requestedModel || sessionModel) : (sessionModel || requestedModel)
  const candidateProvider = options.preferRequested ? (requestedProvider || sessionProvider) : (sessionProvider || requestedProvider)
  const hasGroups = Array.isArray(options.modelGroups) && options.modelGroups.length > 0
  const candidateAvailable = hasGroups && hasModelInGroups(options.modelGroups, candidateProvider, candidateModel)
  const shouldUseDefault = !candidateModel || !candidateProvider || (hasGroups && !candidateAvailable && !isVirtualProvider(candidateProvider))
  const selected = shouldUseDefault
    ? await resolveDefaultModelConfig(options.profile)
    : { model: candidateModel, provider: candidateProvider }
  return options.preserveAuthorizedProvider
    ? selected
    : { ...selected, provider: runtimeProvider(selected.provider) }
}
