import { describe, expect, it } from 'vitest'
import { DEFAULT_REASONING_EFFORTS, agentReasoningEffortOptions, agentReasoningEffortValue, modelReasoningEfforts } from '@/utils/model-reasoning-effort'

describe('model reasoning effort choices', () => {
  const groups = [
    { provider: 'custom:work', model_meta: { glm: { reasoning: true, reasoning_efforts: ['low', 'high', 'max'] }, fast: { reasoning: false } } },
    { provider: 'custom:other', model_meta: { glm: { reasoning: true, reasoning_efforts: ['medium'] } } },
  ]
  it('uses the selected provider and model metadata rather than the global effort ladder', () => {
    expect(modelReasoningEfforts(groups, 'custom:work', 'glm')).toEqual(['low', 'high', 'max'])
    expect(modelReasoningEfforts(groups, 'custom:other', 'glm')).toEqual(['medium'])
    expect(modelReasoningEfforts(groups, 'custom:work', 'fast')).toEqual([])
  })
  it('keeps the existing ladder available when catalog metadata is unknown', () => {
    expect(modelReasoningEfforts(groups, 'custom:private', 'glm')).toEqual(DEFAULT_REASONING_EFFORTS)
    expect(modelReasoningEfforts(groups, 'custom:work', 'private')).toEqual(DEFAULT_REASONING_EFFORTS)
  })

  it('keeps Hermes defaults separate from explicitly disabling reasoning', () => {
    const options = [{ value: '', label: 'Default' }, { value: 'none', label: 'None' }, { value: 'high', label: 'High' }]
    expect(agentReasoningEffortOptions(options, true)).toEqual(options)
    expect(agentReasoningEffortOptions(options, false)).toEqual(options.slice(1))
  })

  it('collapses the workflow default alias without dropping supported effort levels', () => {
    expect(agentReasoningEffortOptions([
      { value: 'default' }, { value: 'low' }, { value: 'none' }, { value: 'high' },
    ], false, 'default')).toEqual([{ value: 'none' }, { value: 'low' }, { value: 'high' }])
  })

  it('preserves catalog choices when the model has no explicit off option', () => {
    const options = [{ value: '' }, { value: 'low' }, { value: 'high' }]
    expect(agentReasoningEffortOptions(options, false)).toEqual(options)
  })

  it('displays unset aliases as none without changing saved effort selections', () => {
    const options = [{ value: 'none' }, { value: 'high' }]
    expect(agentReasoningEffortValue('', options)).toBe('none')
    expect(agentReasoningEffortValue('default', options, 'default')).toBe('none')
    expect(agentReasoningEffortValue('high', options)).toBe('high')
    expect(agentReasoningEffortValue('', [{ value: '' }, ...options])).toBe('')
  })
})
