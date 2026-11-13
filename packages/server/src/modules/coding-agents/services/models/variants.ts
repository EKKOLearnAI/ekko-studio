import type { CodingAgentModel } from '../../contracts/models'

const effortOrder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

/** Only remove a native effort token; Fast and Thinking remain separate families. */
export function nativeModelVariant(id: string) {
  const match = /^(.+?)-(extra-high|none|minimal|low|medium|high|xhigh|max|ultra)((?:-(?:fast|thinking))*)$/.exec(id)
  return match ? { family: `${match[1]}${match[3]}`, effort: match[2] === 'extra-high' ? 'xhigh' : match[2] } : undefined
}

function familyName(model: CodingAgentModel) {
  let name = model.name.replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\(\s*(?:extra\s*high|xhigh|none|minimal|low|medium|high|max|ultra)\s*\)/gi, '')
    .replace(/\b(?:extra\s*high|xhigh|none|minimal|low|medium|high|max|ultra)\b/gi, '')
    .replace(/\s+/g, ' ').trim()
  const family = nativeModelVariant(model.id)?.family || model.id
  if (/-thinking(?:-|$)/.test(family) && !/\bthinking\b/i.test(name)) name += ' (Thinking)'
  if (/-fast(?:-|$)/.test(family) && !/\bfast\b/i.test(name)) name += ' (Fast)'
  return name || family
}

/** Keep every returned native ID for restoration and add grouping metadata. */
export function withNativeModelFamilies(models: CodingAgentModel[]): CodingAgentModel[] {
  const families = new Map<string, CodingAgentModel[]>()
  for (const model of models) {
    const variant = nativeModelVariant(model.id)
    if (!variant || model.hidden) continue
    const members = families.get(variant.family) || []
    members.push(model)
    families.set(variant.family, members)
  }
  return models.map(model => {
    const variant = nativeModelVariant(model.id)
    const family = variant?.family || model.id
    const members = families.get(family)
    if (!members || model.hidden) return model
    const alias = models.find(entry => entry.id === family && !entry.hidden)
    const representative = alias || members.find(entry => entry.isDefault) || members[0]
    const efforts = [...new Set(members.map(entry => nativeModelVariant(entry.id)!.effort))]
      .sort((a, b) => effortOrder.indexOf(a) - effortOrder.indexOf(b))
    return { ...model, modelFamily: family, modelFamilyName: familyName(representative),
      ...(variant ? { reasoningEffort: variant.effort } : {}), reasoningEfforts: efforts }
  })
}

/** A strength change may switch a native ID, never its other model dimensions. */
export function validateNativeModelEffort(models: CodingAgentModel[], currentId: string, nextId: string, effort: string) {
  const current = models.find(model => !model.hidden && (currentId ? model.id === currentId : model.isDefault))
  const next = models.find(model => !model.hidden && model.id === nextId)
  if (!current?.modelFamily || !next || current.modelFamily !== next.modelFamily
    || current.provider !== next.provider || (next.reasoningEffort || '') !== effort) {
    throw Object.assign(new Error('Invalid native model reasoning variant'), { status: 400 })
  }
}
