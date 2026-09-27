import { describe, expect, it } from 'vitest'

import {
  compactCategoryPreset,
  hasCategoryPreset,
  isNewChatProviderAllowedFor,
  presetWarningMessageKey,
  resolveCategoryPreset,
  validateCategoryName,
  type CategoryPresetResolveContext,
  type NewChatAgentId,
  type NewChatAgentMode,
} from '../../packages/client/src/components/hermes/chat/category-new-chat-preset'

const group = (provider: string, models: string[], extra: Record<string, unknown> = {}) => ({
  provider,
  label: provider,
  base_url: '',
  api_key: '',
  models,
  ...extra,
})

const catalog: Record<string, ReturnType<typeof group>[]> = {
  default: [
    group('anthropic', ['claude-opus-5-5', 'claude-sonnet-5']),
    group('openai-codex', ['gpt-5.5'], { auth_type: 'oauth' }),
    group('moa', ['team']),
  ],
  work: [group('anthropic', ['claude-sonnet-5'])],
}

function context(overrides: Partial<CategoryPresetResolveContext> = {}): CategoryPresetResolveContext {
  return {
    currentAgent: 'hermes',
    currentAgentMode: 'scoped',
    profiles: ['default', 'work'],
    defaultProfile: 'default',
    selectableGroups: (profile: string, agent: NewChatAgentId, mode: NewChatAgentMode) =>
      (catalog[profile] || []).filter((item) => isNewChatProviderAllowedFor(item, agent, mode)),
    profileDefaultModel: (profile: string) => (profile === 'default' ? 'claude-sonnet-5' : undefined),
    ...overrides,
  }
}

describe('category New Chat preset resolution', () => {
  it('uses today defaults with the category when there is no preset', () => {
    expect(resolveCategoryPreset(null, context())).toEqual({ profile: 'default', warnings: [] })
    expect(resolveCategoryPreset({}, context())).toEqual({ profile: 'default', warnings: [] })
  })

  it('pre-fills every valid preset field (AC 1-2)', () => {
    const resolved = resolveCategoryPreset({
      agent: 'claude-code',
      agentMode: 'scoped',
      profile: 'default',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      apiMode: 'anthropic_messages',
      baseUrl: 'https://api.example.test',
      reasoningEffort: 'high',
      workspace: '/projects/ai-passport',
    }, context({ workspaceExists: true }))

    expect(resolved).toEqual({
      agent: 'claude-code',
      agentMode: 'scoped',
      profile: 'default',
      modelKind: 'model',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      apiMode: 'anthropic_messages',
      baseUrl: 'https://api.example.test',
      reasoningEffort: 'high',
      workspace: '/projects/ai-passport',
      warnings: [],
    })
  })

  it('falls back per field and warns for a hidden model while keeping valid fields (stale values)', () => {
    const resolved = resolveCategoryPreset({
      agent: 'hermes',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      workspace: '/projects/ai-passport',
    }, context({ workspaceExists: true }))

    expect(resolved.provider).toBe('anthropic')
    expect(resolved.model).toBe('claude-sonnet-5')
    expect(resolved.workspace).toBe('/projects/ai-passport')
    expect(resolved.warnings).toEqual([{ field: 'model', value: 'claude-opus-4-8' }])
    expect(presetWarningMessageKey('model')).toBe('chat.presetWarningModel')
  })

  it('warns and uses the default provider when the preset provider was removed or logged out', () => {
    const resolved = resolveCategoryPreset({ provider: 'gone', model: 'x' }, context())
    expect(resolved.provider).toBeUndefined()
    expect(resolved.model).toBeUndefined()
    expect(resolved.warnings).toEqual([
      { field: 'provider', value: 'gone' },
      { field: 'model', value: 'x' },
    ])
  })

  it('treats OAuth providers as unavailable for scoped external coding agents', () => {
    const resolved = resolveCategoryPreset(
      { agent: 'codex', agentMode: 'scoped', provider: 'openai-codex', model: 'gpt-5.5' },
      context(),
    )
    expect(resolved.warnings.map((warning) => warning.field)).toEqual(['provider', 'model'])
  })

  it('uses the user default profile with a notice when the preset profile is not accessible', () => {
    const resolved = resolveCategoryPreset(
      { profile: 'finance', provider: 'anthropic', model: 'claude-opus-5-5' },
      context(),
    )
    expect(resolved.profile).toBe('default')
    expect(resolved.model).toBe('claude-opus-5-5')
    expect(resolved.warnings).toEqual([{ field: 'profile', value: 'finance' }])
  })

  it('validates models against the preset profile catalog', () => {
    const resolved = resolveCategoryPreset({ profile: 'work', provider: 'anthropic', model: 'claude-opus-5-5' }, context())
    expect(resolved.profile).toBe('work')
    expect(resolved.model).toBe('claude-sonnet-5')
    expect(resolved.warnings).toEqual([{ field: 'model', value: 'claude-opus-5-5' }])
  })

  it('warns about a missing workspace folder and never keeps it (AC 6)', () => {
    const resolved = resolveCategoryPreset({ workspace: '/deleted/folder' }, context({ workspaceExists: false }))
    expect(resolved.workspace).toBeUndefined()
    expect(resolved.warnings).toEqual([{ field: 'workspace', value: '/deleted/folder' }])
  })

  it('warns about a missing DSH preset and only applies DSH presets to DSH', () => {
    expect(resolveCategoryPreset({ agent: 'dsh', agentPreset: 'old' }, context({ dshPresetIds: ['planner'] })).warnings)
      .toEqual([{ field: 'agentPreset', value: 'old' }])
    expect(resolveCategoryPreset({ agent: 'dsh', agentPreset: 'planner' }, context({ dshPresetIds: ['planner'] })).agentPreset)
      .toBe('planner')
    expect(resolveCategoryPreset({ agent: 'hermes', agentPreset: 'planner' }, context()).agentPreset).toBeUndefined()
  })

  it('applies MoA only for Hermes and warns when it is unavailable', () => {
    expect(resolveCategoryPreset({ modelKind: 'moa', model: 'team' }, context())).toMatchObject({
      modelKind: 'moa', provider: 'moa', model: 'team', warnings: [],
    })
    expect(resolveCategoryPreset({ modelKind: 'moa' }, context({ profiles: ['work'], defaultProfile: 'work' })).warnings)
      .toEqual([{ field: 'modelKind', value: 'moa' }])
  })

  it('ignores provider/model for global coding agents and keeps the current agent when none is preset', () => {
    const global = resolveCategoryPreset(
      { agent: 'claude-code', agentMode: 'global', provider: 'anthropic', model: 'claude-opus-5-5', apiMode: 'anthropic_messages' },
      context(),
    )
    expect(global).toEqual({ agent: 'claude-code', agentMode: 'global', profile: 'default', warnings: [] })

    const keepAgent = resolveCategoryPreset({ model: 'claude-opus-5-5' }, context({ currentAgent: 'ekko-agent' }))
    expect(keepAgent.agent).toBeUndefined()
    expect(keepAgent.provider).toBe('anthropic')
  })

  it('never mutates the stored preset', () => {
    const preset = Object.freeze({ provider: 'gone', model: 'x', workspace: '/w' })
    expect(() => resolveCategoryPreset(preset, context({ workspaceExists: false }))).not.toThrow()
    expect(preset).toEqual({ provider: 'gone', model: 'x', workspace: '/w' })
  })
})

describe('category preset helpers', () => {
  it('compacts empty fields so Default selections are not stored', () => {
    expect(compactCategoryPreset({ agent: undefined, model: '  ', provider: ' anthropic ' })).toEqual({ provider: 'anthropic' })
    expect(compactCategoryPreset({ model: '' })).toBeNull()
    expect(hasCategoryPreset(null)).toBe(false)
    expect(hasCategoryPreset({ model: 'm' })).toBe(true)
  })

  it('validates category names: required, max 40 characters, unique case-insensitively', () => {
    expect(validateCategoryName('   ', [])).toBe('required')
    expect(validateCategoryName('x'.repeat(41), [])).toBe('tooLong')
    expect(validateCategoryName('x'.repeat(40), [])).toBeNull()
    expect(validateCategoryName(' ai   PASSPORT ', ['AI Passport'])).toBe('duplicate')
    expect(validateCategoryName('Personal', ['AI Passport'])).toBeNull()
  })
})
