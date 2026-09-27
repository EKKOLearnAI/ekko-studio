import { describe, expect, it } from 'vitest'

import {
  DROPPED_BASE_URL_PLACEHOLDER,
  NEW_CHAT_AGENT_OPTIONS,
  compactCategoryPreset,
  effectiveNewChatMode,
  hasCategoryPreset,
  hasLaunchModeChoice,
  usesBaseUrl,
  usesProviderModel,
  foldAsciiCase,
  isNewChatProviderAllowedFor,
  isSecretLikeParamName,
  presetBaseUrlCarriesCredentials,
  presetWarningMessageKey,
  resolveCategoryPreset,
  validateCategoryName,
  type CategoryPresetResolveContext,
  type NewChatAgentId,
  type NewChatAgentMode,
} from '../../packages/client/src/components/hermes/chat/category-new-chat-preset'
import {
  PRESET_BASE_URLS_WITH_CREDENTIALS,
  PRESET_BASE_URLS_WITHOUT_CREDENTIALS,
  SAFE_PARAM_NAMES,
  SECRET_LIKE_PARAM_NAMES,
} from '../fixtures/preset-base-url-cases'
import { AGENT_OPTIONS } from '../../packages/client/src/utils/agent-options'

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

  it('treats Cursor like the panel: always global, no launch-mode choice, no provider/model', () => {
    const cursor = resolveCategoryPreset(
      { agent: 'cursor', agentMode: 'scoped', provider: 'anthropic', model: 'claude-opus-5-5', apiMode: 'anthropic_messages', baseUrl: 'https://gw.test/v1', workspace: '/p/app' },
      context({ currentAgent: 'claude-code', currentAgentMode: 'scoped' }),
    )
    // The stored launch mode, provider, model, API mode and Base URL are unused (not stale): no warnings.
    expect(cursor).toEqual({ agent: 'cursor', profile: 'default', workspace: '/p/app', warnings: [] })
    expect(effectiveNewChatMode('cursor', 'scoped')).toBe('global')
    expect(usesProviderModel('cursor', 'scoped')).toBe(false)
    expect(hasLaunchModeChoice('cursor')).toBe(false)
    // MoA and DSH presets never apply to Cursor.
    expect(resolveCategoryPreset({ agent: 'cursor', modelKind: 'moa', agentPreset: 'planner' }, context()))
      .toEqual({ agent: 'cursor', profile: 'default', warnings: [] })
  })

  it('offers a launch-mode choice only to external coding agents without a fixed mode', () => {
    expect(hasLaunchModeChoice('hermes')).toBe(false)
    expect(hasLaunchModeChoice('ekko-agent')).toBe(false)
    expect(hasLaunchModeChoice('cursor')).toBe(false)
    for (const agent of ['claude-code', 'codex', 'pi', 'grok', 'opencode', 'dsh'] as const) {
      expect(hasLaunchModeChoice(agent), agent).toBe(true)
    }
    expect(effectiveNewChatMode('ekko-agent', 'global')).toBe('scoped')
  })

  it('lists the same agents in the same order as the New Chat panel picker (#3199)', () => {
    expect(NEW_CHAT_AGENT_OPTIONS.map((option) => option.value)).toEqual(AGENT_OPTIONS.map((option) => option.value))
    expect(NEW_CHAT_AGENT_OPTIONS.map((option) => option.value)).toContain('cursor')
  })

  it('ignores fields that are not preset fields, such as reasoningEffort (CL-016)', () => {
    const legacy = { model: 'claude-opus-5-5', reasoningEffort: 'high' } as any
    expect(resolveCategoryPreset(legacy, context())).toEqual({
      profile: 'default',
      modelKind: 'model',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      warnings: [],
    })
  })

  it('drops a preset Base URL and API mode when the preset provider is stale, with warnings', () => {
    const resolved = resolveCategoryPreset({
      agent: 'claude-code',
      agentMode: 'scoped',
      provider: 'gone-gateway',
      model: 'gw-model',
      apiMode: 'anthropic_messages',
      baseUrl: 'https://gateway.example.test/anthropic',
    }, context())
    expect(resolved.provider).toBeUndefined()
    expect(resolved.baseUrl).toBeUndefined()
    expect(resolved.apiMode).toBeUndefined()
    expect(resolved.warnings).toEqual([
      { field: 'provider', value: 'gone-gateway' },
      { field: 'model', value: 'gw-model' },
      { field: 'baseUrl', value: 'https://gateway.example.test/anthropic' },
      { field: 'apiMode', value: 'anthropic_messages' },
    ])
    expect(presetWarningMessageKey('baseUrl')).toBe('chat.presetWarningBaseUrl')
    expect(presetWarningMessageKey('apiMode')).toBe('chat.presetWarningApiMode')
  })

  it('warns instead of silently skipping a preset Base URL once the provider has its own base_url', () => {
    const withOwnUrl = context({
      selectableGroups: () => [group('anthropic', ['claude-opus-5-5'], { base_url: 'https://api.anthropic.test' })],
    })
    const resolved = resolveCategoryPreset({
      agent: 'claude-code',
      agentMode: 'scoped',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      apiMode: 'chat_completions',
      baseUrl: 'https://proxy.example.test/v1',
    }, withOwnUrl)
    expect(resolved).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' })
    expect(resolved.baseUrl).toBeUndefined()
    expect(resolved.apiMode).toBeUndefined()
    expect(resolved.warnings).toEqual([
      { field: 'baseUrl', value: 'https://proxy.example.test/v1' },
      { field: 'apiMode', value: 'chat_completions' },
    ])

    // An API mode saved without a Base URL for that same provider still applies.
    const apiModeOnly = resolveCategoryPreset(
      { agent: 'claude-code', agentMode: 'scoped', provider: 'anthropic', model: 'claude-opus-5-5', apiMode: 'chat_completions' },
      withOwnUrl,
    )
    expect(apiModeOnly).toMatchObject({ apiMode: 'chat_completions', warnings: [] })
  })

  it('never applies a preset Base URL to a provider inferred from the model instead of the preset provider', () => {
    const resolved = resolveCategoryPreset(
      { agent: 'claude-code', agentMode: 'scoped', model: 'claude-opus-5-5', baseUrl: 'https://proxy.example.test/v1' },
      context(),
    )
    expect(resolved.provider).toBe('anthropic')
    expect(resolved.baseUrl).toBeUndefined()
    expect(resolved.warnings).toEqual([{ field: 'baseUrl', value: 'https://proxy.example.test/v1' }])
  })

  it('drops a preset Base URL and API mode when the preset provider has no models, instead of leaving them for another provider', () => {
    const noModels = context({
      selectableGroups: () => [group('gateway', []), group('anthropic', ['claude-opus-5-5'])],
    })
    const resolved = resolveCategoryPreset({
      agent: 'claude-code',
      agentMode: 'scoped',
      provider: 'gateway',
      apiMode: 'anthropic_messages',
      baseUrl: 'https://gateway.example.test/anthropic',
    }, noModels)
    expect(resolved.model || undefined).toBeUndefined()
    expect(resolved.baseUrl).toBeUndefined()
    expect(resolved.apiMode).toBeUndefined()
    expect(resolved.warnings).toEqual([
      { field: 'baseUrl', value: 'https://gateway.example.test/anthropic' },
      { field: 'apiMode', value: 'anthropic_messages' },
    ])
    // An API mode alone for that provider is dropped too: the provider is not applied.
    const apiModeOnly = resolveCategoryPreset(
      { agent: 'claude-code', agentMode: 'scoped', provider: 'gateway', apiMode: 'chat_completions' },
      noModels,
    )
    expect(apiModeOnly.apiMode).toBeUndefined()
    expect(apiModeOnly.warnings).toEqual([{ field: 'apiMode', value: 'chat_completions' }])
  })

  it('validates a "Default" agent preset against the agent in effect when the drawer opens', () => {
    // Saved with Agent = Default: no agent, so no agent-specific rule applies at save time.
    const preset = { provider: 'openai-codex', model: 'gpt-5.5' }
    // Last agent used was Hermes: the OAuth provider is fine.
    expect(resolveCategoryPreset(preset, context({ currentAgent: 'hermes' }))).toMatchObject({
      provider: 'openai-codex', model: 'gpt-5.5', warnings: [],
    })
    // Last agent used was a scoped Claude: the same preset gets the per-field stale warnings.
    const scoped = resolveCategoryPreset(preset, context({ currentAgent: 'claude-code', currentAgentMode: 'scoped' }))
    expect(scoped.agent).toBeUndefined()
    expect(scoped.provider).toBeUndefined()
    expect(scoped.warnings.map((warning) => warning.field)).toEqual(['provider', 'model'])
    // Last agent used was a global Claude: provider/model are not used at all, nothing to warn about.
    expect(resolveCategoryPreset(preset, context({ currentAgent: 'claude-code', currentAgentMode: 'global' })).warnings).toEqual([])
    // MoA saved with Default agent only applies while Hermes is in effect.
    expect(resolveCategoryPreset({ modelKind: 'moa', model: 'team' }, context({ currentAgent: 'codex', currentAgentMode: 'scoped' })).warnings)
      .toEqual([{ field: 'modelKind', value: 'moa' }])
  })

  it('keeps a relative workspace as entered and only drops it when the server says it is missing', () => {
    expect(resolveCategoryPreset({ workspace: 'projects/app' }, context({ workspaceExists: true })).workspace).toBe('projects/app')
    expect(resolveCategoryPreset({ workspace: 'projects/app' }, context()).workspace).toBe('projects/app')
    expect(resolveCategoryPreset({ workspace: 'projects/app' }, context({ workspaceExists: false })).warnings)
      .toEqual([{ field: 'workspace', value: 'projects/app' }])
  })

  it('never mutates the stored preset', () => {
    const preset = Object.freeze({ provider: 'gone', model: 'x', workspace: '/w' })
    expect(() => resolveCategoryPreset(preset, context({ workspaceExists: false }))).not.toThrow()
    expect(preset).toEqual({ provider: 'gone', model: 'x', workspace: '/w' })
  })
})

describe('category preset whose stored Base URL the server dropped', () => {
  it('warns on the Base URL field without the value, unless a new Base URL replaces it', () => {
    const preset = { agent: 'claude-code', agentMode: 'scoped', provider: 'anthropic', model: 'claude-opus-5-5' } as const
    const resolved = resolveCategoryPreset(preset, context({ storedBaseUrlDropped: true }))
    expect(resolved.baseUrl).toBeUndefined()
    expect(resolved.apiMode).toBeUndefined()
    expect(resolved.warnings).toEqual([{ field: 'baseUrl', value: DROPPED_BASE_URL_PLACEHOLDER }])
    // Every other stored field was kept and still applies.
    expect(resolved).toMatchObject({ agent: 'claude-code', provider: 'anthropic', model: 'claude-opus-5-5' })
    // Nothing else left in the preset: still warned while the drawer agent uses a Base URL.
    expect(resolveCategoryPreset(null, context({
      storedBaseUrlDropped: true,
      currentAgent: 'claude-code',
      currentAgentMode: 'scoped',
    })).warnings).toEqual([{ field: 'baseUrl', value: DROPPED_BASE_URL_PLACEHOLDER }])
    // The form typed a new Base URL: the old drop no longer matters.
    expect(resolveCategoryPreset({ ...preset, baseUrl: 'https://gw.test/v1' }, context({ storedBaseUrlDropped: true })).warnings)
      .toEqual([])
    expect(resolveCategoryPreset(preset, context()).warnings).toEqual([])
  })

  it('warns only when the resolved agent/mode uses a Base URL, like the drawer Base URL field', () => {
    const dropped = context({ storedBaseUrlDropped: true })
    // Cursor is always global: no Base URL field, so no warning.
    expect(resolveCategoryPreset({ agent: 'cursor' }, dropped).warnings).toEqual([])
    // A stored scoped mode is ignored for Cursor too.
    expect(resolveCategoryPreset({ agent: 'cursor', agentMode: 'scoped' }, dropped).warnings).toEqual([])
    // claude-code in global mode: no Base URL field.
    expect(resolveCategoryPreset({ agent: 'claude-code', agentMode: 'global' }, dropped).warnings).toEqual([])
    // A global drawer agent with no preset agent: no warning either.
    expect(resolveCategoryPreset({ model: 'claude-opus-5-5' }, context({
      storedBaseUrlDropped: true,
      currentAgent: 'claude-code',
      currentAgentMode: 'global',
    })).warnings).toEqual([])
    // Hermes has no Base URL field.
    expect(resolveCategoryPreset({ model: 'claude-opus-5-5' }, dropped).warnings).toEqual([])
    // Scoped external agents use one: warned.
    for (const agent of ['claude-code', 'codex', 'opencode'] as const) {
      expect(resolveCategoryPreset({ agent, agentMode: 'scoped' }, dropped).warnings)
        .toEqual([{ field: 'baseUrl', value: DROPPED_BASE_URL_PLACEHOLDER }])
    }
    // The drawer agent is scoped and the preset names no agent: warned.
    expect(resolveCategoryPreset({ model: 'claude-opus-5-5' }, context({
      storedBaseUrlDropped: true,
      currentAgent: 'claude-code',
      currentAgentMode: 'scoped',
    })).warnings).toEqual([{ field: 'baseUrl', value: DROPPED_BASE_URL_PLACEHOLDER }])
  })

  it('shares the Base URL condition with the drawer field', () => {
    expect(usesBaseUrl('hermes', 'scoped')).toBe(false)
    expect(usesBaseUrl('cursor', 'scoped')).toBe(false)
    expect(usesBaseUrl('cursor', 'global')).toBe(false)
    expect(usesBaseUrl('claude-code', 'global')).toBe(false)
    expect(usesBaseUrl('claude-code', 'scoped')).toBe(true)
    expect(usesBaseUrl('ekko-agent', 'global')).toBe(true)
  })
})

describe('category preset helpers', () => {
  it('compacts empty fields so Default selections are not stored', () => {
    expect(compactCategoryPreset({ agent: undefined, model: '  ', provider: ' anthropic ' })).toEqual({ provider: 'anthropic' })
    expect(compactCategoryPreset({ model: '' })).toBeNull()
    expect(hasCategoryPreset(null)).toBe(false)
    expect(hasCategoryPreset({ model: 'm' })).toBe(true)
  })

  it('detects credentials in a Base URL exactly like the server rule (same corpus)', () => {
    for (const url of PRESET_BASE_URLS_WITH_CREDENTIALS) expect(presetBaseUrlCarriesCredentials(url), url).toBe(true)
    for (const url of PRESET_BASE_URLS_WITHOUT_CREDENTIALS) expect(presetBaseUrlCarriesCredentials(url), url).toBe(false)
  })

  it('matches secret-like parameter names by whole word or known compound, like the server rule (same corpus)', () => {
    for (const name of SECRET_LIKE_PARAM_NAMES) expect(isSecretLikeParamName(name), name).toBe(true)
    for (const name of SAFE_PARAM_NAMES) expect(isSecretLikeParamName(name), name).toBe(false)
  })

  it('validates category names: required, max 40 characters, unique case-insensitively', () => {
    expect(validateCategoryName('   ', [])).toBe('required')
    expect(validateCategoryName('x'.repeat(41), [])).toBe('tooLong')
    expect(validateCategoryName('x'.repeat(40), [])).toBeNull()
    expect(validateCategoryName(' ai   PASSPORT ', ['AI Passport'])).toBe('duplicate')
    expect(validateCategoryName('Personal', ['AI Passport'])).toBeNull()
  })

  it('folds case like SQLite NOCASE (ASCII only), so the server 409 and the form agree', () => {
    expect(foldAsciiCase('AI Été')).toBe('ai Été')
    expect(validateCategoryName('Été', ['été'])).toBeNull()
    expect(validateCategoryName('ÉTÉ', ['été'])).toBeNull()
    expect(validateCategoryName('Été Plans', ['été plans'])).toBeNull()
    expect(validateCategoryName('Été', ['Été'])).toBe('duplicate')
    expect(validateCategoryName('ÉtÉ WORK', ['Été work'])).toBeNull()
    expect(validateCategoryName('Été WORK', ['Été work'])).toBe('duplicate')
  })
})
