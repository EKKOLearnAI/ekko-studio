import { resolveModelReasoningEffort, type ReasoningModelMetadata } from '../../../../../shared/reasoning-effort'
import { getModelCatalog, resolveCatalogModel, catalogReasoningEfforts } from './model-catalog'

/** Resolve defaults at execution time too, for workflows, group runs and older sessions. */
export function studioModelReasoningEffort(input: {
  model?: string
  provider?: string
  baseUrl?: string
  reasoningEffort?: string | null
  metadata?: ReasoningModelMetadata
}): string | undefined {
  const catalog = getModelCatalog()
  const model = catalog && input.model ? resolveCatalogModel(catalog, { ...input, model: input.model })?.model : undefined
  return resolveModelReasoningEffort(input.reasoningEffort, input.metadata ?? (model ? {
    reasoning: model.reasoning,
    reasoning_efforts: catalogReasoningEfforts(model),
  } : undefined))
}
