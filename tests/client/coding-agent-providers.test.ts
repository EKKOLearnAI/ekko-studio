import { describe, expect, it } from 'vitest'
import {
  configuredProviderApiMode,
  canScopedCodingAgentUseProvider,
  isAuthModelProvider,
  usesServerManagedProviderAuth,
} from '../../packages/client/src/utils/codingAgentProviders'

describe('coding agent provider visibility', () => {
  it.each([
    'ekko-agent', 'claude-code', 'codex', 'pi', 'grok', 'opencode', 'dsh', 'cursor',
    'antigravity', 'qwen', 'kimi', 'codebuddy', 'qoder', 'copilot', 'zcode',
  ] as const)('keeps Hermes MoA combinations hidden from %s', agentId => {
    expect(canScopedCodingAgentUseProvider(agentId, 'moa')).toBe(false)
    expect(canScopedCodingAgentUseProvider(agentId, ' MoA ')).toBe(false)
    expect(canScopedCodingAgentUseProvider(agentId, 'test-provider')).toBe(true)
  })

  it.each(['nous', 'openai-codex', 'copilot', 'xai-oauth', 'qwen-oauth', 'claude-oauth', 'minimax-oauth'])(
    'exposes %s to scoped Ekko sessions',
    (provider) => {
      expect(isAuthModelProvider(provider)).toBe(true)
      expect(canScopedCodingAgentUseProvider('ekko-agent', provider)).toBe(true)
      expect(usesServerManagedProviderAuth('ekko-agent', provider)).toBe(true)
    },
  )

  it.each(['claude-code', 'codex'] as const)(
    'keeps auth providers hidden from scoped %s sessions',
    (agentId) => {
      expect(canScopedCodingAgentUseProvider(agentId, 'openai-codex')).toBe(false)
      expect(canScopedCodingAgentUseProvider(agentId, 'qwen-oauth')).toBe(false)
      expect(usesServerManagedProviderAuth(agentId, 'openai-codex')).toBe(false)
      expect(canScopedCodingAgentUseProvider(agentId, 'deepseek')).toBe(true)
    },
  )
})


describe('configured Provider protocol selection', () => {
  const group = { provider: 'custom:gateway', label: 'Gateway', base_url: 'https://example.test', models: ['model'], api_key: '' }

  it('uses the saved mode and leaves missing/unsupported modes available for manual selection', () => {
    expect(configuredProviderApiMode({ ...group, api_mode: 'anthropic_messages' })).toBe('anthropic_messages')
    expect(configuredProviderApiMode(group)).toBeUndefined()
    expect(configuredProviderApiMode({ ...group, api_mode: 'bedrock_converse' })).toBeUndefined()
  })

  it('uses model metadata for mixed catalogs without guessing for unknown models', () => {
    const mixed = { ...group, api_mode_by_model: { gpt: 'codex_responses' as const, claude: 'anthropic_messages' as const, gemini: null } }
    expect(configuredProviderApiMode(mixed, 'gpt')).toBe('codex_responses')
    expect(configuredProviderApiMode(mixed, 'claude')).toBe('anthropic_messages')
    expect(configuredProviderApiMode(mixed, 'gemini')).toBeUndefined()
    expect(configuredProviderApiMode(mixed, 'new-model')).toBeUndefined()
  })
})
