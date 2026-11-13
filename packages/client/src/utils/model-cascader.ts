import type { AvailableModelGroup } from '@/api/hermes/system'

export function modelCascaderGroups(
  groups: AvailableModelGroup[],
  customModels: Record<string, string[]>,
  search: string,
  displayName: (model: string, provider: string) => string,
): AvailableModelGroup[] {
  const query = search.trim().toLocaleLowerCase()
  return groups.map(group => {
    const models = [...new Set([...group.models, ...(customModels[group.provider] || [])])]
    const providerMatches = [group.provider, group.label].some(value => value.toLocaleLowerCase().includes(query))
    return { ...group, models: !query || providerMatches ? models : models.filter(model =>
      [model, displayName(model, group.provider)].some(value => value.toLocaleLowerCase().includes(query)),
    ) }
  }).filter(group => !query || group.models.length || [group.provider, group.label].some(value => value.toLocaleLowerCase().includes(query)))
}
