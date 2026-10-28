import { describe, expect, it } from 'vitest'
import { lowestReasoningEffort, resolveModelReasoningEffort } from '../../packages/shared/reasoning-effort'

describe('minimum supported reasoning', () => {
  it.each([
    { efforts: ['none', 'high', 'low', 'xhigh', 'max'], expected: 'low' },
    { efforts: ['high', 'minimal', 'low'], expected: 'minimal' },
    { efforts: ['high', 'medium'], expected: 'medium' },
    { efforts: ['high'], expected: 'high' },
    { efforts: ['disabled', 'enabled'], expected: 'enabled' },
    { efforts: ['none'], expected: undefined },
    { efforts: [], expected: undefined },
    { efforts: undefined, expected: 'low' },
  ])('chooses $expected from $efforts', ({ efforts, expected }) => {
    expect(lowestReasoningEffort(efforts)).toBe(expected)
    for (const unset of [undefined, '', 'default']) {
      expect(resolveModelReasoningEffort(unset, { reasoning_efforts: efforts })).toBe(expected)
    }
  })
  it('preserves supported explicit selections and repairs unsupported old none values', () => {
    const metadata = { reasoning_efforts: ['low', 'high', 'xhigh', 'max'] }
    expect(resolveModelReasoningEffort('xhigh', metadata)).toBe('xhigh')
    expect(resolveModelReasoningEffort('none', metadata)).toBe('low')
    expect(resolveModelReasoningEffort('none', { reasoning_efforts: ['none', 'low'] })).toBe('none')
  })
  it('omits effort for models without reasoning even after a model switch', () => {
    expect(resolveModelReasoningEffort('xhigh', { reasoning: false })).toBeUndefined()
  })
})
