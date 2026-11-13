import type { CodingAgentModel } from '@/api/coding-agents'

export interface NativeEffortChoice { model: string; effort: string }

export function nativeCatalogModel(models: CodingAgentModel[] = [], id: string) {
  const current = models.find(model => model.isDefault && !model.hidden)
  if (!id) return current
  const candidates = models.filter(model => model.id === id && !model.hidden)
  return candidates.find(model => model.provider === current?.provider) || candidates[0]
}

export function nativeModelLabel(models: CodingAgentModel[] | undefined, id: string, defaultLabel: string) {
  if (!id) return defaultLabel
  const model = nativeCatalogModel(models, id)
  return model?.modelFamilyName || model?.resolvedModel || model?.name || id
}

export function nativeModelFamilies(models: CodingAgentModel[] = []) {
  const families = new Map<string, CodingAgentModel[]>()
  const visible = models.filter(model => !model.hidden)
  for (const model of visible.filter(model => model.id !== 'default' || !model.resolvedModel
    || !visible.some(other => other.id !== 'default' && other.provider === model.provider
      && other.resolvedModel === model.resolvedModel))) {
    const key = JSON.stringify([model.provider, model.modelFamily || model.id])
    const members = families.get(key) || []
    members.push(model)
    families.set(key, members)
  }
  return [...families.values()].map(members => members.find(model => model.isDefault)
    || members.find(model => !model.reasoningEffort) || members[0])
}

export function nativeModelPickerId(models: CodingAgentModel[] = [], id: string) {
  if (!id) return ''
  const selected = nativeCatalogModel(models, id)
  if (id === 'default' && selected?.resolvedModel) {
    const concreteChoice = nativeModelFamilies(models).find(model => model.provider === selected.provider
      && model.resolvedModel === selected.resolvedModel)
    if (concreteChoice) return concreteChoice.id
  }
  return nativeModelFamilies(models).find(model => model.provider === selected?.provider
    && (model.modelFamily || model.id) === (selected?.modelFamily || id))?.id || id
}

export function nativeModelEffortChoices(models: CodingAgentModel[] = [], id: string): NativeEffortChoice[] | undefined {
  const selected = nativeCatalogModel(models, id)
  if (!selected?.modelFamily) return undefined
  const members = models.filter(model => !model.hidden && model.provider === selected.provider && model.modelFamily === selected.modelFamily)
  const alias = members.find(model => !model.reasoningEffort)
  return [
    ...(alias ? [{ model: alias.id, effort: '' }] : []),
    ...(selected.reasoningEfforts || []).flatMap(effort => {
      const variant = members.find(model => model.reasoningEffort === effort)
      return variant ? [{ model: variant.id, effort }] : []
    }),
  ]
}

export function selectNativeModelEffort(models: CodingAgentModel[] = [], id: string, effort: string) {
  const selected = nativeCatalogModel(models, id)
  const choices = nativeModelEffortChoices(models, id)
  if (!choices) return { model: id, reasoningEffort: effort }
  const choice = choices.find(choice => choice.effort === effort)
    || choices.find(choice => choice.model === nativeModelPickerId(models, selected?.id || id))
  return { model: choice?.model || selected?.id || id, reasoningEffort: choice?.effort || '' }
}
