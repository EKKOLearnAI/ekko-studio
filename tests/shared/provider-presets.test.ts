import { describe, expect, it } from 'vitest'

import {
  PROVIDER_PRESETS as SERVER_PROVIDER_PRESETS,
  buildProviderModelMap as buildServerProviderModelMap,
} from '../../packages/server/src/modules/studio/contracts/providers'
import { PROVIDER_ENV_MAP } from '../../packages/server/src/modules/hermes/services/profiles/config'

const OPENAI_CODEX_PROVIDER = 'openai-codex'
const COPILOT_PROVIDER = 'copilot'
const FUN_CODEX_PROVIDER = 'fun-codex'
const LONGCAT_PROVIDER = 'longcat'
const KIMI_CODING_PROVIDER = 'kimi-coding'
const KIMI_CODING_CN_PROVIDER = 'kimi-coding-cn'
const GLM_CODING_PLAN_PROVIDER = 'glm'
const ALIBABA_CODING_PLAN_PROVIDER = 'alibaba-coding-plan'
const MINIMAX_PROVIDER = 'minimax'
const MINIMAX_OAUTH_PROVIDER = 'minimax-oauth'
const MINIMAX_CN_PROVIDER = 'minimax-cn'

const STEPFUN_PROVIDER = 'stepfun'
const XAI_OAUTH_PROVIDER = 'xai-oauth'
const CLAUDE_OAUTH_PROVIDER = 'claude-oauth'
const ANTHROPIC_PROVIDER = 'anthropic'
const GPT_5_5_MODEL = 'gpt-5.5'

// Ordered fallback manifests audited against NousResearch/hermes-agent
// 4281151ae859241351ba14d8c7682dc67ff4c126. Codex values come from
// hermes_cli/codex_models.py; Nous values match the docs catalog at
// bab0d42038f84f44e0673e347f18f1c347daab599ce78128ed237763638b038e.
const EXPECTED_SYNCED_PROVIDER_MODELS = {
  'openai-codex': [
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
  'openai-api': [
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
  nous: [
    'anthropic/claude-fable-5',
    'anthropic/claude-opus-4.8',
    'anthropic/claude-sonnet-5',
    'anthropic/claude-haiku-4.5',
    'openai/gpt-5.6-sol',
    'openai/gpt-5.6-sol-pro',
    'openai/gpt-5.6-terra',
    'openai/gpt-5.6-terra-pro',
    'openai/gpt-5.6-luna',
    'openai/gpt-5.6-luna-pro',
    'openai/gpt-5.5',
    'openai/gpt-5.5-pro',
    'openai/gpt-5.4-mini',
    'google/gemini-3-pro-preview',
    'google/gemini-3.1-pro-preview',
    'google/gemini-3.5-flash',
    'x-ai/grok-4.5',
    'deepseek/deepseek-v4-pro',
    'deepseek/deepseek-v4-flash',
    'qwen/qwen3.7-max',
    'qwen/qwen3.7-plus',
    'qwen/qwen3.6-35b-a3b',
    'moonshotai/kimi-k2.6',
    'moonshotai/kimi-k2.7-code',
    'minimax/minimax-m3',
    'z-ai/glm-5.2',
    'z-ai/glm-5.1',
    'xiaomi/mimo-v2.5-pro',
    'tencent/hy3',
    'stepfun/step-3.7-flash',
    'nvidia/nemotron-3-super-120b-a12b',
    'sakana/fugu-ultra',
  ],
  gemini: [
    'gemini-3.1-pro-preview',
    'gemini-3-pro-preview',
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite-preview',
  ],
  'kimi-coding': [
    'kimi-k2.7-code',
    'kimi-k2.6',
    'kimi-k2.5',
    'kimi-for-coding',
    'kimi-k2-thinking',
    'kimi-k2-thinking-turbo',
    'kimi-k2-turbo-preview',
    'kimi-k2-0905-preview',
  ],
  zai: [
    'glm-5.2',
    'glm-5.1',
    'glm-5',
    'glm-5v-turbo',
    'glm-5-turbo',
    'glm-4.7',
    'glm-4.5',
    'glm-4.5-flash',
  ],
  'opencode-go': [
    'kimi-k2.7-code',
    'kimi-k2.6',
    'kimi-k2.5',
    'glm-5.2',
    'glm-5.1',
    'glm-5',
    'mimo-v2.5-pro',
    'mimo-v2.5',
    'mimo-v2-pro',
    'mimo-v2-omni',
    'minimax-m3',
    'minimax-m2.7',
    'minimax-m2.5',
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'qwen3.7-max',
    'qwen3.7-plus',
    'qwen3.6-plus',
    'qwen3.5-plus',
  ],
  xai: [
    'grok-build-0.1',
    'grok-composer-2.5-fast',
    'grok-4.5',
    'grok-4.3',
    'grok-4.20-0309-reasoning',
    'grok-4.20-0309-non-reasoning',
    'grok-4.20-multi-agent-0309',
  ],
  'xai-oauth': [
    'grok-build-0.1',
    'grok-composer-2.5-fast',
    'grok-4.5',
    'grok-4.3',
    'grok-4.20-0309-reasoning',
    'grok-4.20-0309-non-reasoning',
    'grok-4.20-multi-agent-0309',
  ],
  nvidia: [
    'nvidia/nemotron-3-ultra-550b-a55b',
    'nvidia/nemotron-3-super-120b-a12b',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    'z-ai/glm-5.2',
    'moonshotai/kimi-k2.6',
    'minimaxai/minimax-m3',
  ],
  'opencode-zen': [
    'kimi-k2.5',
    'kimi-k2.6',
    'gpt-5.5',
    'gpt-5.5-pro',
    'gpt-5.4-pro',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.3-codex',
    'gpt-5.3-codex-spark',
    'gpt-5.2',
    'gpt-5.2-codex',
    'gpt-5.1',
    'gpt-5.1-codex',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex-mini',
    'gpt-5',
    'gpt-5-codex',
    'gpt-5-nano',
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-opus-4-5',
    'claude-opus-4-1',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'claude-sonnet-4',
    'claude-haiku-4-5',
    'gemini-3.5-flash',
    'gemini-3.1-pro',
    'gemini-3-flash',
    'minimax-m3',
    'minimax-m2.7',
    'minimax-m2.5',
    'glm-5.2',
    'glm-5.1',
    'glm-5',
    'kimi-k2.7-code',
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'deepseek-v4-flash-free',
    'qwen3.7-plus',
    'qwen3.6-plus',
    'qwen3.5-plus',
    'grok-build-0.1',
    'big-pickle',
    'mimo-v2.5-free',
    'north-mini-code-free',
    'nemotron-3-ultra-free',
  ],
} as const

function modelsForProvider(providerPresets: Array<{ value: string; models: string[] }>, provider: string): string[] {
  const preset = providerPresets.find((candidate) => candidate.value === provider)
  expect(preset).toBeDefined()
  return preset?.models ?? []
}

describe('provider presets', () => {
  it('keeps every built-in provider preset registered in the env map', () => {
    const missingMappings = SERVER_PROVIDER_PRESETS
      .filter(candidate => candidate.builtin)
      .map(candidate => candidate.value)
      .filter(provider => !Object.prototype.hasOwnProperty.call(PROVIDER_ENV_MAP, provider))

    expect(missingMappings).toEqual([])
  })

  it('routes apikey.fan Codex through the Responses transport', () => {
    const preset = SERVER_PROVIDER_PRESETS.find((candidate) => candidate.value === FUN_CODEX_PROVIDER)
    expect(preset?.api_mode).toBe('codex_responses')
  })

  it('routes LongCat through the Responses transport', () => {
    const preset = SERVER_PROVIDER_PRESETS.find((candidate) => candidate.value === LONGCAT_PROVIDER)
    expect(preset?.api_mode).toBe('codex_responses')
  })

  it('lists GPT-5.5 for OpenAI Codex', () => {
    expect(modelsForProvider(SERVER_PROVIDER_PRESETS, OPENAI_CODEX_PROVIDER)).toContain(GPT_5_5_MODEL)
  })

  it('exposes GPT-5.5 through provider model maps', () => {
    expect(buildServerProviderModelMap()[OPENAI_CODEX_PROVIDER]).toContain(GPT_5_5_MODEL)
  })

  it('treats xAI OAuth as OAuth-only for availability checks', () => {
    expect(PROVIDER_ENV_MAP[XAI_OAUTH_PROVIDER]).toEqual({ api_key_env: '', base_url_env: '' })
  })

  it('does not expose the retired Gemini CLI OAuth provider', () => {
    expect(PROVIDER_ENV_MAP).not.toHaveProperty('google-gemini-cli')
    expect(SERVER_PROVIDER_PRESETS.find(candidate => candidate.value === 'google-gemini-cli')).toBeUndefined()
  })

  it('treats Claude OAuth as OAuth-only while keeping Anthropic API key separate', () => {
    expect(PROVIDER_ENV_MAP[CLAUDE_OAUTH_PROVIDER]).toEqual({ api_key_env: '', base_url_env: '' })
    expect(PROVIDER_ENV_MAP.anthropic).toEqual({ api_key_env: 'ANTHROPIC_API_KEY', base_url_env: 'ANTHROPIC_BASE_URL' })
    expect(modelsForProvider(SERVER_PROVIDER_PRESETS, CLAUDE_OAUTH_PROVIDER)).toContain('claude-sonnet-4-6')
  })

  it('includes Claude Fable 5 for direct Anthropic and Claude OAuth', () => {
    expect(modelsForProvider(SERVER_PROVIDER_PRESETS, ANTHROPIC_PROVIDER)).toContain('claude-fable-5')
    expect(modelsForProvider(SERVER_PROVIDER_PRESETS, CLAUDE_OAUTH_PROVIDER)).toContain('claude-fable-5')
  })

  it('keeps Kimi Coding Plan and China credentials distinct without duplicate Moonshot presets', () => {
    expect(PROVIDER_ENV_MAP[KIMI_CODING_PROVIDER]).toEqual({ api_key_env: 'KIMI_API_KEY', base_url_env: 'KIMI_BASE_URL' })
    expect(PROVIDER_ENV_MAP[KIMI_CODING_CN_PROVIDER]).toEqual({ api_key_env: 'KIMI_CN_API_KEY', base_url_env: '' })
    expect(PROVIDER_ENV_MAP).not.toHaveProperty('moonshot')

    expect(SERVER_PROVIDER_PRESETS.find(candidate => candidate.value === KIMI_CODING_PROVIDER)?.base_url).toBe('https://api.kimi.com/coding/v1')
    expect(SERVER_PROVIDER_PRESETS.find(candidate => candidate.value === KIMI_CODING_CN_PROVIDER)?.base_url).toBe('https://api.kimi.cn/coding/v1')
    expect(SERVER_PROVIDER_PRESETS.find(candidate => candidate.value === KIMI_CODING_CN_PROVIDER)?.label).toBe('Kimi for Coding China')
    expect(SERVER_PROVIDER_PRESETS.find(candidate => candidate.value === 'moonshot')).toBeUndefined()
  })

  it('aligns GLM Coding Plan with Hermes Agent China coding endpoint', () => {
    const preset = SERVER_PROVIDER_PRESETS.find(candidate => candidate.value === GLM_CODING_PLAN_PROVIDER)
    expect(preset?.base_url).toBe('https://open.bigmodel.cn/api/coding/paas/v4')
    expect(preset?.api_mode).toBeUndefined()
    expect(PROVIDER_ENV_MAP[GLM_CODING_PLAN_PROVIDER]).toEqual({ api_key_env: 'GLM_API_KEY', base_url_env: '' })
    expect(modelsForProvider(SERVER_PROVIDER_PRESETS, GLM_CODING_PLAN_PROVIDER)).toEqual([
      'glm-5.2',
      'glm-5.1',
      'glm-5v-turbo',
      'glm-4.7',
    ])
  })

  it('includes Qwen 3.7 Plus in the Alibaba Coding Plan fallback catalog', () => {
    expect(modelsForProvider(SERVER_PROVIDER_PRESETS, ALIBABA_CODING_PLAN_PROVIDER)).toContain('qwen3.7-plus')
  })

  it('does not expose incomplete built-in provider presets', () => {
    expect(PROVIDER_ENV_MAP).not.toHaveProperty('azure-foundry')
    expect(SERVER_PROVIDER_PRESETS.find(candidate => candidate.value === 'azure-foundry')).toBeUndefined()
    expect(SERVER_PROVIDER_PRESETS.filter(candidate => candidate.builtin && !candidate.base_url && candidate.models.length === 0)).toEqual([])
  })

  it('includes Step 3.7 Flash in the StepFun fallback catalog', () => {
    expect(modelsForProvider(SERVER_PROVIDER_PRESETS, STEPFUN_PROVIDER)).toContain('step-3.7-flash')
  })

  it('keeps MiniMax M3 first while retaining currently supported M2.x Anthropic models', () => {
    expect(PROVIDER_ENV_MAP[MINIMAX_PROVIDER]).toEqual({ api_key_env: 'MINIMAX_API_KEY', base_url_env: 'MINIMAX_BASE_URL' })
    expect(PROVIDER_ENV_MAP[MINIMAX_CN_PROVIDER]).toEqual({ api_key_env: 'MINIMAX_CN_API_KEY', base_url_env: 'MINIMAX_CN_BASE_URL' })

    for (const provider of [MINIMAX_PROVIDER, MINIMAX_CN_PROVIDER]) {
      const models = modelsForProvider(SERVER_PROVIDER_PRESETS, provider)
      expect(models[0]).toBe('MiniMax-M3')
      expect(models).toEqual(expect.arrayContaining([
        'MiniMax-M2.7',
        'MiniMax-M2.7-highspeed',
        'MiniMax-M2.5',
        'MiniMax-M2.5-highspeed',
        'MiniMax-M2.1',
        'MiniMax-M2.1-highspeed',
        'MiniMax-M2',
      ]))
    }
  })

  it('keeps MiniMax Coding Plan OAuth separate from API-key providers', () => {
    expect(PROVIDER_ENV_MAP[MINIMAX_OAUTH_PROVIDER]).toEqual({ api_key_env: '', base_url_env: '' })
    const preset = SERVER_PROVIDER_PRESETS.find(candidate => candidate.value === MINIMAX_OAUTH_PROVIDER)
    expect(preset).toMatchObject({
      base_url: 'https://api.minimax.io/anthropic',
      api_mode: 'anthropic_messages',
    })
    expect(modelsForProvider(SERVER_PROVIDER_PRESETS, MINIMAX_OAUTH_PROVIDER)).toEqual([
      'MiniMax-M3',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
    ])
  })

  it('includes current GitHub Copilot fallback models', () => {
    const models = modelsForProvider(SERVER_PROVIDER_PRESETS, COPILOT_PROVIDER)
    expect(models).toEqual(expect.arrayContaining([
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-nano',
      'claude-opus-4.8',
      'gemini-3.5-flash',
      'raptor-mini',
    ]))
    expect(models).not.toContain('grok-code-fast-1')
  })

  it('matches the audited ordered fallback manifests for synchronized providers', () => {
    const modelMap = buildServerProviderModelMap()
    for (const [provider, expectedModels] of Object.entries(EXPECTED_SYNCED_PROVIDER_MODELS)) {
      expect(modelsForProvider(SERVER_PROVIDER_PRESETS, provider)).toEqual(expectedModels)
      expect(modelMap[provider]).toEqual(expectedModels)
    }

    expect(modelsForProvider(SERVER_PROVIDER_PRESETS, OPENAI_CODEX_PROVIDER)).not.toContain('codex-auto-review')
    expect(modelsForProvider(SERVER_PROVIDER_PRESETS, 'openai-api')).not.toContain('gpt-5.3-codex-spark')
    const xaiModels = modelsForProvider(SERVER_PROVIDER_PRESETS, 'xai')
    for (const nonChatModel of [
      'grok-imagine-image',
      'grok-imagine-image-quality',
      'grok-imagine-video',
      'grok-imagine-video-15s',
    ]) {
      expect(xaiModels).not.toContain(nonChatModel)
    }
  })
})

describe('OrcaRouter provider presets', () => {
  const ORCAROUTER = 'orcarouter'
  const ORCAROUTER_OAUTH = 'orcarouter-oauth'

  it('registers both first-class entries with the OpenAI-compatible inference base', () => {
    for (const provider of [ORCAROUTER, ORCAROUTER_OAUTH]) {
      const preset = SERVER_PROVIDER_PRESETS.find(candidate => candidate.value === provider)
      expect(preset).toBeDefined()
      expect(preset?.builtin).toBe(true)
      expect(preset?.base_url).toBe('https://api.orcarouter.ai/v1')
      expect(preset?.api_mode).toBe('chat_completions')
      // A gateway is not a custom base URL: the provider must stay a named,
      // first-class entry with its own label.
      expect(preset?.label).toMatch(/^OrcaRouter/)
    }
  })

  it('maps the API-key entry to the profile env and leaves the Auth entry keyless', () => {
    expect(PROVIDER_ENV_MAP[ORCAROUTER]).toEqual({
      api_key_env: 'ORCAROUTER_API_KEY',
      base_url_env: 'ORCAROUTER_BASE_URL',
    })
    expect(PROVIDER_ENV_MAP[ORCAROUTER_OAUTH]).toEqual({ api_key_env: '', base_url_env: '' })
  })

  it('seeds only the verified cold-start catalog, never the live gateway list', () => {
    const models = modelsForProvider(SERVER_PROVIDER_PRESETS, ORCAROUTER)
    expect(models).toEqual([
      'openai/gpt-5.5',
      'anthropic/claude-opus-4.8',
      'google/gemini-3.5-flash',
      'deepseek/deepseek-v4-pro',
      'orcarouter/auto',
    ])
    expect(modelsForProvider(SERVER_PROVIDER_PRESETS, ORCAROUTER_OAUTH)).toEqual(models)
  })

  it('keeps vendor/model namespaces verbatim in the seed', () => {
    for (const model of modelsForProvider(SERVER_PROVIDER_PRESETS, ORCAROUTER)) {
      expect(model).toMatch(/^[a-z0-9.-]+\/[a-z0-9.-]+$/)
    }
  })
})
