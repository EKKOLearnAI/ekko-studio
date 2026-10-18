import { describe, expect, it } from 'vitest'
import { nativeModelLabel, nativeModelFamilies, nativeModelPickerId, nativeModelEffortChoices, selectNativeModelEffort } from '@/utils/native-model-families'
import type { CodingAgentModel } from '@/api/coding-agents'

const models: CodingAgentModel[] = [
  { id: 'gemini-pro-high', name: 'Gemini Pro (High)', modelFamily: 'gemini-pro', modelFamilyName: 'Gemini Pro', reasoningEffort: 'high', reasoningEfforts: ['low', 'high'] },
  { id: 'gemini-pro-low', name: 'Gemini Pro (Low)', modelFamily: 'gemini-pro', modelFamilyName: 'Gemini Pro', reasoningEffort: 'low', reasoningEfforts: ['low', 'high'] },
  { id: 'codex-low-fast', name: 'Codex Low Fast', modelFamily: 'codex-fast', reasoningEffort: 'low', reasoningEfforts: ['low', 'xhigh'] },
  { id: 'codex-fast', name: 'Codex Fast', modelFamily: 'codex-fast', reasoningEfforts: ['low', 'xhigh'] },
  { id: 'codex-extra-high-fast', name: 'Codex Extra High Fast', modelFamily: 'codex-fast', reasoningEffort: 'xhigh', reasoningEfforts: ['low', 'xhigh'] },
  { id: 'codex-low', name: 'Codex Low', modelFamily: 'codex', reasoningEffort: 'low', reasoningEfforts: ['low'] },
  { id: 'hidden-low', name: 'Hidden Low', hidden: true, modelFamily: 'hidden', reasoningEffort: 'low' },
]

describe('native family choices', () => {
  it('uses concrete native metadata for labels without substituting unavailable or default selections', () => {
    const claude = [{ id: 'opus', name: 'Opus (claude-opus-5-5)', resolvedModel: 'claude-opus-5-5' }]
    expect(nativeModelLabel(claude, 'opus', 'Agent default')).toBe('claude-opus-5-5')
    expect(nativeModelLabel(claude, 'claude-opus-4-8', 'Agent default')).toBe('claude-opus-4-8')
    expect(nativeModelLabel(undefined, 'opus', 'Agent default')).toBe('opus')
    expect(nativeModelLabel(claude, '', 'Agent default')).toBe('Agent default')
    expect(nativeModelLabel(models, 'codex-extra-high-fast', 'Agent default')).toBe('Codex Extra High Fast')
    expect(nativeModelLabel(models, 'gemini-pro-high', 'Agent default')).toBe('Gemini Pro')
  })
  it('restores literal variant IDs into one selected picker row without losing Fast', () => {
    expect(nativeModelFamilies(models).map(model => model.id)).toEqual(['gemini-pro-high', 'codex-fast', 'codex-low'])
    expect(nativeModelPickerId(models, 'gemini-pro-low')).toBe('gemini-pro-high')
    expect(nativeModelPickerId(models, 'codex-extra-high-fast')).toBe('codex-fast')
    expect(nativeModelPickerId(models, '')).toBe('')
  })
  it('offers only real variants and preserves the literal alias for default', () => {
    expect(nativeModelEffortChoices(models, 'gemini-pro-high')).toEqual([{ model: 'gemini-pro-low', effort: 'low' }, { model: 'gemini-pro-high', effort: 'high' }])
    expect(selectNativeModelEffort(models, 'gemini-pro-high', 'low')).toEqual({ model: 'gemini-pro-low', reasoningEffort: 'low' })
    expect(selectNativeModelEffort(models, 'codex-extra-high-fast', '')).toEqual({ model: 'codex-fast', reasoningEffort: '' })
    expect(selectNativeModelEffort(models, 'codex-fast', 'xhigh')).toEqual({ model: 'codex-extra-high-fast', reasoningEffort: 'xhigh' })
  })
  it('accepts old cached catalogs without family metadata', () => {
    const legacy = [{ id: 'gemini-pro-high', name: 'Gemini Pro (High)' }]
    expect(nativeModelEffortChoices(legacy, 'gemini-pro-high')).toBeUndefined()
    expect(nativeModelPickerId(legacy, 'gemini-pro-high')).toBe('gemini-pro-high')
    expect(nativeModelFamilies(legacy)).toEqual(legacy)
  })
  it('removes duplicate native defaults without changing persisted alias or context selectors', () => {
    const claude: CodingAgentModel[] = [
      { id: 'default', name: 'claude-opus-5-5', resolvedModel: 'claude-opus-5-5', isDefault: true },
      { id: 'opus', name: 'claude-opus-5-5', resolvedModel: 'claude-opus-5-5' },
      { id: 'claude-fable-5-1[1m]', name: 'claude-fable-5-1', resolvedModel: 'claude-fable-5-1' },
      { id: 'sonnet', name: 'claude-sonnet-5-5', resolvedModel: 'claude-sonnet-5-5' },
      { id: 'haiku', name: 'claude-haiku-5-5', resolvedModel: 'claude-haiku-5-5' },
    ]
    expect(nativeModelFamilies(claude).map(model => model.id)).toEqual(['opus', 'claude-fable-5-1[1m]', 'sonnet', 'haiku'])
    expect(nativeModelPickerId(claude, 'default')).toBe('opus')
    expect(selectNativeModelEffort(claude, 'default', 'high')).toEqual({ model: 'default', reasoningEffort: 'high' })
    expect(selectNativeModelEffort(claude, 'claude-fable-5-1[1m]', 'high')).toEqual({ model: 'claude-fable-5-1[1m]', reasoningEffort: 'high' })
    expect(nativeModelFamilies([{ id: 'default', name: 'Only default', resolvedModel: 'one' }])).toHaveLength(1)
    expect(nativeModelFamilies([claude[0], { ...claude[1], provider: 'another-account' }])).toHaveLength(2)
  })
})
