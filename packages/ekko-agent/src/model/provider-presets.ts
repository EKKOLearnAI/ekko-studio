import type { ModelProviderType, ModelRequestStyle } from './types'

/** Public API modes persisted in Ekko config. */
export type EkkoModelApiMode =
  | 'chat_completions'
  | 'codex_responses'
  | 'anthropic_messages'
  | 'gemini_contents'
  | 'prompt_completion'
  | 'custom_runtime'

export type EkkoModelProviderAuthType = 'none' | 'api-key' | 'oauth'

export interface EkkoModelProviderPreset {
  id: string
  label: string
  type: ModelProviderType
  apiMode: EkkoModelApiMode
  requestStyle: ModelRequestStyle
  baseUrl: string
  defaultModel: string
  models: string[]
  authType: EkkoModelProviderAuthType
  builtin: boolean
}

/**
 * Curated defaults mirrored from Ekko Studio's provider registry.
 *
 * This intentionally contains the common first-party and authorized providers
 * instead of copying Studio's entire marketplace-sized catalog. Every entry
 * carries an explicit API mode so installing a preset never depends on URL
 * inference.
 */
export const BUILTIN_MODEL_PROVIDER_PRESETS: Record<string, EkkoModelProviderPreset> = presetMap([
  {
    id: 'openai-api',
    label: 'OpenAI API',
    type: 'openai',
    apiMode: 'codex_responses',
    requestStyle: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6-sol',
    models: [
      'gpt-5.6-sol',
      'gpt-5.6-sol-pro',
      'gpt-5.6-terra',
      'gpt-5.6-terra-pro',
      'gpt-5.6-luna',
      'gpt-5.6-luna-pro',
      'gpt-5.5',
      'gpt-5.5-pro',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5-mini',
      'gpt-5.3-codex',
      'gpt-4.1',
      'gpt-4o',
      'gpt-4o-mini',
    ],
    authType: 'api-key',
    builtin: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    type: 'anthropic',
    apiMode: 'anthropic_messages',
    requestStyle: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-fable-5',
    models: [
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-20250514',
      'claude-sonnet-4-20250514',
      'claude-haiku-4-5-20251001',
    ],
    authType: 'api-key',
    builtin: true,
  },
  {
    id: 'gemini',
    label: 'Google AI Studio',
    type: 'openai-compatible',
    apiMode: 'chat_completions',
    requestStyle: 'openai-chat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-3.1-pro-preview',
    models: [
      'gemini-3.1-pro-preview',
      'gemini-3-pro-preview',
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite-preview',
    ],
    authType: 'api-key',
    builtin: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    type: 'openai-compatible',
    apiMode: 'chat_completions',
    requestStyle: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-pro',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'],
    authType: 'api-key',
    builtin: true,
  },
  {
    id: 'xai',
    label: 'xAI',
    type: 'openai-compatible',
    apiMode: 'codex_responses',
    requestStyle: 'openai-responses',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-build-0.1',
    models: [
      'grok-build-0.1',
      'grok-composer-2.5-fast',
      'grok-4.5',
      'grok-4.3',
      'grok-4.20-0309-reasoning',
      'grok-4.20-0309-non-reasoning',
      'grok-4.20-multi-agent-0309',
    ],
    authType: 'api-key',
    builtin: true,
  },
  {
    id: 'alibaba',
    label: 'Alibaba Cloud',
    type: 'openai-compatible',
    apiMode: 'chat_completions',
    requestStyle: 'openai-chat',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3.7-max',
    models: [
      'qwen3.7-max',
      'qwen3.6-plus',
      'kimi-k2.5',
      'qwen3.5-plus',
      'qwen3-coder-plus',
      'qwen3-coder-next',
      'glm-5',
      'glm-4.7',
      'MiniMax-M2.5',
    ],
    authType: 'api-key',
    builtin: true,
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    type: 'anthropic',
    apiMode: 'anthropic_messages',
    requestStyle: 'anthropic-messages',
    baseUrl: 'https://api.minimax.io/anthropic/v1',
    defaultModel: 'MiniMax-M3',
    models: [
      'MiniMax-M3',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
      'MiniMax-M2.1',
      'MiniMax-M2.1-highspeed',
      'MiniMax-M2',
    ],
    authType: 'api-key',
    builtin: true,
  },
  {
    id: 'nous',
    label: 'Nous Portal',
    type: 'openai-compatible',
    apiMode: 'chat_completions',
    requestStyle: 'openai-chat',
    baseUrl: 'https://inference-api.nousresearch.com/v1',
    defaultModel: 'anthropic/claude-fable-5',
    models: [
      'anthropic/claude-fable-5',
      'anthropic/claude-opus-4.8',
      'anthropic/claude-sonnet-5',
      'anthropic/claude-haiku-4.5',
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-terra',
      'openai/gpt-5.6-luna',
      'openai/gpt-5.5',
      'google/gemini-3.1-pro-preview',
      'google/gemini-3.5-flash',
      'x-ai/grok-4.5',
      'deepseek/deepseek-v4-pro',
      'qwen/qwen3.7-max',
      'moonshotai/kimi-k2.7-code',
      'minimax/minimax-m3',
      'z-ai/glm-5.2',
    ],
    authType: 'oauth',
    builtin: true,
  },
  {
    id: 'openai-codex',
    label: 'OpenAI Codex',
    type: 'openai-compatible',
    apiMode: 'codex_responses',
    requestStyle: 'openai-responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    defaultModel: 'gpt-5.6-sol',
    models: [
      'gpt-5.6-sol',
      'gpt-5.6-sol-pro',
      'gpt-5.6-terra',
      'gpt-5.6-terra-pro',
      'gpt-5.6-luna',
      'gpt-5.6-luna-pro',
      'gpt-5.5',
      'gpt-5.4-mini',
      'gpt-5.4',
      'gpt-5.3-codex',
      'gpt-5.3-codex-spark',
    ],
    authType: 'oauth',
    builtin: true,
  },
  {
    id: 'xai-oauth',
    label: 'xAI Grok OAuth',
    type: 'openai-compatible',
    apiMode: 'codex_responses',
    requestStyle: 'openai-responses',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-build-0.1',
    models: [
      'grok-build-0.1',
      'grok-composer-2.5-fast',
      'grok-4.5',
      'grok-4.3',
      'grok-4.20-0309-reasoning',
      'grok-4.20-0309-non-reasoning',
      'grok-4.20-multi-agent-0309',
    ],
    authType: 'oauth',
    builtin: true,
  },
  {
    id: 'qwen-oauth',
    label: 'Qwen OAuth',
    type: 'openai-compatible',
    apiMode: 'chat_completions',
    requestStyle: 'openai-chat',
    baseUrl: 'https://portal.qwen.ai/v1',
    defaultModel: 'qwen3.5-plus',
    models: ['qwen3.5-plus', 'qwen3-coder-plus', 'qwen3-coder-next'],
    authType: 'oauth',
    builtin: true,
  },
  {
    id: 'claude-oauth',
    label: 'Claude OAuth',
    type: 'anthropic',
    apiMode: 'anthropic_messages',
    requestStyle: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-fable-5-1',
    models: [
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
    ],
    authType: 'oauth',
    builtin: true,
  },
  {
    id: 'minimax-oauth',
    label: 'MiniMax Coding Plan',
    type: 'anthropic',
    apiMode: 'anthropic_messages',
    requestStyle: 'anthropic-messages',
    baseUrl: 'https://api.minimax.io/anthropic',
    defaultModel: 'MiniMax-M3',
    models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed'],
    authType: 'oauth',
    builtin: true,
  },
])

export function listBuiltInModelProviderPresets(): EkkoModelProviderPreset[] {
  return Object.values(BUILTIN_MODEL_PROVIDER_PRESETS).map(preset => structuredClone(preset))
}

export function getBuiltInModelProviderPreset(id: string): EkkoModelProviderPreset | undefined {
  const preset = BUILTIN_MODEL_PROVIDER_PRESETS[String(id || '').trim().toLowerCase()]
  return preset ? structuredClone(preset) : undefined
}

export function modelApiModeToRequestStyle(apiMode: EkkoModelApiMode): ModelRequestStyle {
  if (apiMode === 'chat_completions') return 'openai-chat'
  if (apiMode === 'codex_responses') return 'openai-responses'
  if (apiMode === 'anthropic_messages') return 'anthropic-messages'
  if (apiMode === 'gemini_contents') return 'gemini-contents'
  if (apiMode === 'prompt_completion') return 'prompt-completion'
  return 'custom-runtime'
}

export function requestStyleToModelApiMode(requestStyle: ModelRequestStyle): EkkoModelApiMode {
  if (requestStyle === 'openai-chat') return 'chat_completions'
  if (requestStyle === 'openai-responses') return 'codex_responses'
  if (requestStyle === 'anthropic-messages') return 'anthropic_messages'
  if (requestStyle === 'gemini-contents') return 'gemini_contents'
  if (requestStyle === 'prompt-completion') return 'prompt_completion'
  return 'custom_runtime'
}

function presetMap(presets: EkkoModelProviderPreset[]): Record<string, EkkoModelProviderPreset> {
  return Object.fromEntries(presets.map(preset => [preset.id, preset]))
}
