import { getModelCatalog, resolveCatalogModel, catalogReasoningEfforts } from '../../../studio/public/model-catalog'
import { PROVIDER_PRESETS, resolveProviderConnectionApiMode, type ProviderApiMode } from '../../../studio/contracts/providers'

interface CatalogModelGroup {
  provider: string
  base_url: string
  models: string[]
  api_mode?: ProviderApiMode
  api_mode_by_model?: Record<string, ProviderApiMode | null>
  model_meta?: Record<string, { reasoning?: boolean; reasoning_efforts?: string[] }>
}

// Keep one enricher per response so profiles and allProviders share the same
// lookup results, including misses. Never reuse results across endpoint URLs.
export function createCatalogModelMetadataEnricher(
  selectModels: (group: CatalogModelGroup) => string[] = group => group.models,
) {
  const catalog = getModelCatalog()
  const scannedByProvider = new Map<string, Map<string, ReturnType<typeof resolveCatalogModel>>>()
  return function applyCatalogModelMetadata<T extends CatalogModelGroup>(groups: T[]): T[] {
    return groups.map(group => {
      const protocol = PROVIDER_PRESETS.find(preset => preset.value === group.provider)?.catalog_api_mode
      if (protocol === 'per_model' || (!group.api_mode && !group.api_mode_by_model)) {
        const modes = Object.fromEntries(selectModels(group)
          .map(id => [id, resolveProviderConnectionApiMode(group.provider, group.base_url, id) ?? null]))
        if (protocol === 'per_model' || Object.values(modes).some(Boolean)) {
          group = { ...group, api_mode_by_model: modes }
        }
      }
      if (!catalog) return group
      let scanned = scannedByProvider.get(group.provider)
      if (!scanned) {
        scanned = new Map()
        scannedByProvider.set(group.provider, scanned)
      }
      const meta = { ...group.model_meta }
      for (const id of selectModels(group)) {
        const key = JSON.stringify([group.base_url, id])
        if (!scanned.has(key)) {
          scanned.set(key, resolveCatalogModel(catalog, { provider: group.provider, baseUrl: group.base_url, model: id }))
        }
        const model = scanned.get(key)?.model
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
}
