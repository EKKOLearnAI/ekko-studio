import { getModelCatalog, resolveCatalogModel, catalogReasoningEfforts } from '../../../studio/public/model-catalog'
import { resolveModelBaseUrlForProfile } from './endpoint'

export interface ModelMetadataQuery {
  profile?: string
  provider: string
  model: string
  baseUrl?: string
}

/** Resolve only the model a consumer is using; listing providers never calls this. */
export function getModelMetadata(query: ModelMetadataQuery): { reasoning?: boolean; reasoning_efforts?: string[] } {
  const catalog = getModelCatalog()
  if (!catalog) return {}
  const baseUrl = query.baseUrl || resolveModelBaseUrlForProfile(query.profile || 'default', query.provider, query.model)
  const model = resolveCatalogModel(catalog, { ...query, baseUrl })?.model
  if (!model) return {}
  const efforts = catalogReasoningEfforts(model)
  return {
    ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
    ...(efforts !== undefined ? { reasoning_efforts: efforts } : {}),
  }
}
