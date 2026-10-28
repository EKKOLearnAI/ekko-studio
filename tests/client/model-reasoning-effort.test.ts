import { describe, expect, it } from 'vitest'
import { agentReasoningEffortOptions, agentReasoningEffortValue, modelReasoningEfforts } from '@/utils/model-reasoning-effort'

describe('model reasoning effort choices', () => {
  const groups = [
    { provider: 'custom:work', model_meta: { glm: { reasoning: true, reasoning_efforts: ['low', 'high', 'max'] }, fast: { reasoning: false } } },
    { provider: 'custom:other', model_meta: { glm: { reasoning: true, reasoning_efforts: ['medium'] } } },
  ]
  it('uses the selected provider and model metadata', () => {
    expect(modelReasoningEfforts(groups, 'custom:work', 'glm')).toEqual(['low', 'high', 'max'])
    expect(modelReasoningEfforts(groups, 'custom:other', 'glm')).toEqual(['medium'])
    expect(modelReasoningEfforts(groups, 'custom:work', 'fast')).toEqual([])
  })
  it('starts unknown models at low without offering unsupported off or minimal defaults', () => {
    expect(modelReasoningEfforts(groups, 'custom:private', 'glm')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
  it('selects the minimum while keeping explicit none for every agent', () => {
    const options = [{ value: '' }, { value: 'none' }, { value: 'low' }, { value: 'xhigh' }]
    const choices = agentReasoningEffortOptions(options)
    expect(choices).toEqual(options.slice(1))
    expect(agentReasoningEffortValue('', choices)).toBe('low')
    expect(agentReasoningEffortValue('none', choices)).toBe('none')
    expect(agentReasoningEffortValue('xhigh', choices)).toBe('xhigh')
  })
  it('resolves a workflow default using capability order rather than list order', () => {
    const choices = agentReasoningEffortOptions([{ value: 'default' }, { value: 'high' }, { value: 'minimal' }, { value: 'none' }], 'default')
    expect(agentReasoningEffortValue('default', choices, 'default')).toBe('minimal')
  })
  it('does not invent an effort for a model without thinking controls', () => {
    const choices = agentReasoningEffortOptions([{ value: '' }])
    expect(choices).toEqual([{ value: '' }])
    expect(agentReasoningEffortValue('', choices)).toBe('')
  })
})
