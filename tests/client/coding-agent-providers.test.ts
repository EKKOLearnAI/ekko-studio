import { describe, expect, it } from 'vitest'
import {
  canScopedCodingAgentUseProvider,
  isAuthModelProvider,
  usesServerManagedProviderAuth,
} from '../../packages/client/src/utils/codingAgentProviders'

describe('coding agent provider visibility', () => {
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
