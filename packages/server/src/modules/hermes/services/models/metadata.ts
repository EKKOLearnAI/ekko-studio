import { PROVIDER_PRESETS } from '../../../studio/contracts/providers'
import { getModelCatalog, findCatalogModelByProvider, catalogReasoningEfforts } from '../../../studio/public/model-catalog'

interface CatalogModelGroup {
  provider: string
  base_url: string
  models: string[]
  model_meta?: Record<string, { reasoning?: boolean; reasoning_efforts?: string[] }>
}

export function applyCatalogModelMetadata<T extends CatalogModelGroup>(groups: T[]): T[] {
  const catalog = getModelCatalog()
  if (!catalog) return groups
  const normalizeUrl = (url: string) => url.trim().toLowerCase().replace(/\/+$/, '')
  return groups.map(group => {
    // Preserve existing custom-provider inference by full preset URL.
    // Arbitrary gateways must not borrow another provider's effort settings.
    const provider = group.provider === 'custom' || group.provider.startsWith('custom:')
      ? PROVIDER_PRESETS.find(preset => normalizeUrl(preset.base_url) === normalizeUrl(group.base_url))?.value
      : group.provider
    if (!provider) return group
    const meta = { ...group.model_meta }
    for (const id of group.models) {
      const model = findCatalogModelByProvider(catalog, provider, id)
      if (!model) continue
      const efforts = catalogReasoningEfforts(model)
      meta[id] = {
        ...meta[id],
        ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
        ...(efforts !== undefined ? { reasoning_efforts: efforts } : {}),
      }
    }
    return Object.keys(meta).length ? { ...group, model_meta: meta } : group
  })
}
