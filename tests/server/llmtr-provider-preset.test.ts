import { describe, expect, it } from 'vitest'
import { PROVIDER_ENV_MAP } from '../../packages/server/src/modules/hermes/services/profiles/config'
import {
  PROVIDER_PRESETS,
  resolveProviderCatalogApiMode,
  resolveProviderConnectionApiMode,
} from '../../packages/server/src/modules/studio/contracts/providers'

describe('LLMTR provider preset', () => {
  const preset = PROVIDER_PRESETS.find(entry => entry.value === 'llmtr')

  it('is a chat-completions preset on the LLMTR endpoint', () => {
    expect(preset).toMatchObject({
      label: 'LLMTR',
      builtin: true,
      base_url: 'https://llmtr.com/v1',
      api_mode: 'chat_completions',
      catalog_api_mode: 'chat_completions',
    })
    expect(preset?.models).toContain('llmtr/qwen3-8-27b')
  })

  it('is saved as a custom provider with the key in config, not an env var', () => {
    // Hermes has no built-in llmtr provider, so it follows the LongCat pattern.
    expect(PROVIDER_ENV_MAP.llmtr).toEqual({ api_key_env: '', base_url_env: '' })
  })

  it('resolves chat completions for the preset and for a custom relay on the same URL', () => {
    expect(resolveProviderCatalogApiMode('llmtr', 'anthropic/claude-sonnet-5')).toBe('chat_completions')
    expect(resolveProviderConnectionApiMode('custom:my-llmtr', 'https://llmtr.com/v1/', 'llmtr/qwen3-8-27b')).toBe('chat_completions')
  })
})
