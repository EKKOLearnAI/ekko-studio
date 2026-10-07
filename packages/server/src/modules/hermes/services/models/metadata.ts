import { getModelCatalog, resolveCatalogModel, catalogReasoningEfforts } from '../../../studio/public/model-catalog'

interface CatalogModelGroup {
  provider: string
  base_url: string
  models: string[]
  model_meta?: Record<string, { reasoning?: boolean; reasoning_efforts?: string[] }>
}

export function applyCatalogModelMetadata<T extends CatalogModelGroup>(groups: T[]): T[] {
  const catalog = getModelCatalog()
  if (!catalog) return groups
  return groups.map(group => {
    const meta = { ...group.model_meta }
    for (const id of group.models) {
      const model = resolveCatalogModel(catalog, { provider: group.provider, baseUrl: group.base_url, model: id })?.model
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
