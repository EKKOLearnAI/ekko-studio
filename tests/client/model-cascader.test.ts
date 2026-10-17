import { describe, expect, it } from 'vitest'
import { modelCascaderGroups } from '@/utils/model-cascader'
import type { AvailableModelGroup } from '@/api/hermes/system'

const groups = [
  { provider: 'work', label: 'Work Provider', models: ['shared', 'disabled'], model_meta: { disabled: { disabled: true } } },
  { provider: 'personal', label: 'Personal Provider', models: ['shared', 'fast'] },
] as AvailableModelGroup[]
const display = (model: string, provider: string) => provider === 'work' && model === 'shared' ? 'Review alias' : model

describe('model cascader catalog', () => {
  it('searches provider labels, aliases and native IDs without mixing providers', () => {
    expect(modelCascaderGroups(groups, {}, 'work provider', display)[0].models).toEqual(['shared', 'disabled'])
    expect(modelCascaderGroups(groups, {}, 'review alias', display).map(group => group.provider)).toEqual(['work'])
    expect(modelCascaderGroups(groups, {}, 'shared', display).map(group => group.provider)).toEqual(['work', 'personal'])
    expect(modelCascaderGroups(groups, {}, 'unknown', display)).toEqual([])
  })
  it('merges unlisted models only into their configured provider and preserves disabled metadata', () => {
    const result = modelCascaderGroups(groups, { work: ['shared', 'custom', 'custom'], removed: ['private'] }, '', display)
    expect(result[0].models).toEqual(['shared', 'disabled', 'custom'])
    expect(result[1].models).toEqual(['shared', 'fast'])
    expect(result[0].model_meta?.disabled.disabled).toBe(true)
    expect(groups[0].models).toEqual(['shared', 'disabled'])
  })
})
