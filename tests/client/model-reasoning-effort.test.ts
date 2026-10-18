import { describe, expect, it } from 'vitest'
import { DEFAULT_REASONING_EFFORTS, modelReasoningEfforts } from '@/utils/model-reasoning-effort'

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
})
