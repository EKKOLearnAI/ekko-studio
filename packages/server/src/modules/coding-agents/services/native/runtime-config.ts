import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NativeCodingAgentId } from '../../../studio/contracts/agents/native-coding-agents'

interface NativeScopedInput {
  agentId: Exclude<NativeCodingAgentId, 'qoder'>
  rootDir: string
  model: string
  baseUrl: string
  token: string
  contextWindow: number
  outputLimit: number
}

export function nativeScopedUsesChatCompletions(agentId: NativeCodingAgentId, model: string): boolean {
  // Copilot's Anthropic tokenizer only knows canonical Claude model IDs.
  // Custom models retain their real ID and use its generic OpenAI BYOK client.
  return agentId === 'codebuddy' || (agentId === 'copilot' && !/^claude[-.]/i.test(model.trim()))
}

/** Only per-session runtime files are written; upstream credentials stay in the proxy. */
export async function prepareNativeScopedRuntime(input: NativeScopedInput) {
  const { agentId, rootDir, model, baseUrl, token } = input
  const contextWindow = Math.max(1, Math.floor(input.contextWindow || 128000))
  const outputLimit = Math.max(1, Math.floor(input.outputLimit || 8192))
  const files: Array<{ key: string; path: string; absolutePath: string }> = []
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
  const write = async (key: string, path: string, content: string) => {
    const absolutePath = join(rootDir, path)
    await writeFile(absolutePath, content, { encoding: 'utf8', mode: 0o600 })
    files.push({ key, path, absolutePath })
  }
  await mkdir(rootDir, { recursive: true, mode: 0o700 })
  let args: string[] = []
  let env: Record<string, string>
  if (agentId === 'qwen') {
    env = { QWEN_HOME: rootDir, QWEN_RUNTIME_DIR: join(rootDir, 'runtime'),
      ANTHROPIC_API_KEY: token, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_MODEL: model,
      ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '', OPENAI_BASE_URL: '', OPENAI_MODEL: '' }
    await write('settings', 'settings.json', json({ security: { auth: { selectedType: 'anthropic' } },
      model: { name: model }, modelProviders: { anthropic: [{ id: model, envKey: 'ANTHROPIC_API_KEY', baseUrl,
        generationConfig: { maxOutputTokens: outputLimit } }] } }))
    args = ['--auth-type', 'anthropic', '--model', model]
  } else if (agentId === 'kimi') {
    env = { KIMI_CODE_HOME: rootDir, KIMI_MODEL_NAME: model, KIMI_MODEL_PROVIDER_TYPE: 'anthropic',
      KIMI_MODEL_BASE_URL: baseUrl, KIMI_MODEL_API_KEY: token,
      KIMI_MODEL_MAX_CONTEXT_SIZE: String(contextWindow), KIMI_MODEL_MAX_OUTPUT_SIZE: String(outputLimit),
      KIMI_MODEL_CAPABILITIES: '', KIMI_MODEL_THINKING_EFFORT: '', KIMI_MODEL_ADAPTIVE_THINKING: 'false',
      KIMI_MODEL_THINKING_KEEP: 'none', KIMI_CUSTOM_HEADERS: '', KIMI_DISABLE_TELEMETRY: '1' }
    // The documented KIMI_MODEL_* override is in-memory; credentials are not persisted.
    await write('config', 'config.toml', '# Model and local proxy credentials are supplied by the session environment.\n')
  } else if (agentId === 'codebuddy') {
    // A unique native alias prevents project models.json from replacing this route.
    // The proxy always forwards the selected Studio model, including auxiliary calls.
    const alias = `ekko-scoped-${createHash('sha256').update(rootDir).digest('hex').slice(0, 16)}`
    env = { CODEBUDDY_CONFIG_DIR: rootDir, EKKO_SCOPED_MODEL_TOKEN: token,
      CODEBUDDY_MODEL: alias, CODEBUDDY_SMALL_FAST_MODEL: alias, CODEBUDDY_BIG_SLOW_MODEL: alias,
      CODEBUDDY_CODE_SUBAGENT_MODEL: alias, CODEBUDDY_API_KEY: token, CODEBUDDY_AUTH_TOKEN: '',
      CODEBUDDY_BASE_URL: baseUrl, CODEBUDDY_CUSTOM_HEADERS: '' }
    await write('models', 'models.json', json({ models: [{ id: alias, name: model, vendor: 'Ekko Studio',
      apiKey: '${EKKO_SCOPED_MODEL_TOKEN}', url: `${baseUrl}/chat/completions`,
      maxInputTokens: contextWindow, maxOutputTokens: outputLimit, supportsToolCall: true,
      relatedModels: { lite: alias, reasoning: alias, subagent: alias } }], availableModels: [alias] }))
    await write('settings', 'settings.json', json({ model: alias, variantModels: { lite: alias, reasoning: alias } }))
    args = ['--model', alias]
  } else if (agentId === 'copilot') {
    const usesChatCompletions = nativeScopedUsesChatCompletions(agentId, model)
    env = { COPILOT_HOME: rootDir, COPILOT_PROVIDER_TYPE: usesChatCompletions ? 'openai' : 'anthropic', COPILOT_PROVIDER_BASE_URL: baseUrl,
      COPILOT_PROVIDER_API_KEY: token, COPILOT_PROVIDER_MODEL_ID: model, COPILOT_PROVIDER_WIRE_MODEL: model,
      COPILOT_MODEL: model, COPILOT_PROVIDER_MAX_PROMPT_TOKENS: String(contextWindow),
      COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: String(outputLimit), COPILOT_OFFLINE: 'true',
      COPILOT_PROVIDERS_CONFIG: '', COPILOT_PROVIDER_API_KEY_COMMAND: '', COPILOT_PROVIDER_BEARER_TOKEN: '',
      COPILOT_PROVIDER_HEADERS: '', COPILOT_PROVIDER_WIRE_API: usesChatCompletions ? 'completions' : '',
      COPILOT_PROVIDER_TRANSPORT: 'http', COPILOT_GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: '' }
    await write('config', 'config.json', json({ model }))
    args = ['--model', model]
  } else {
    const builtinPath = join(rootDir, 'zcode-builtin.json')
    const personalPath = join(rootDir, 'personal-providers.json')
    env = { ZCODE_STORAGE_DIR: join(rootDir, 'storage'), ZCODE_DATA_BASE_DIR: rootDir,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinPath, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalPath,
      ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: '' }
    // Official ZCode schemaVersion 1: a minimal offline builtin layer supplies
    // model defaults; the personal layer owns the scoped provider and selection.
    await write('builtin', 'zcode-builtin.json', json({ schemaVersion: 1, revision: 0, config: {
      providerConfigRules: { providerRules: [], templateRules: [] }, modelConfigRules: {
        modelRules: [{ modelMatch: '.*', config: { enabled: true, properties: { contextWindow,
          requiresMfjsToolSchema: false, inputFormat: { supportsText: true, supportsImage: false,
            supportsVideo: false, supportsAudio: false, supportsPdf: false }, outputFormat: { supportsText: true },
          supportsToolCall: true, supportsJsonSchemaOutput: false, supportsNativeWebSearch: false,
          supportsMidConversationSystem: false }, optionSpecs: {
            reasoningLevel: { values: ['disabled'], map: '{}' },
            maxOutputTokens: { max: outputLimit, map: "{'max_tokens': maxOutputTokens}" } } } }],
        modelApiRules: [], providerSiteRules: [], templateModelRules: [], builtinProviderModelRules: [] } } }))
    await write('providers', 'personal-providers.json', json({ schemaVersion: 1, config: {
      providerOrder: ['ekko-scoped'], providerConfigRules: { providerRules: [{ providerId: 'ekko-scoped',
        providerName: 'Ekko Studio', enabled: true, config: { group: 'standard-personal',
          access: { type: 'api-key', apiKey: token }, api: { type: 'anthropic-messages', baseUrl },
          personalModelIds: [model] } }] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      defaultModelSelection: { providerId: 'ekko-scoped', modelId: model, options: { reasoningLevel: 'disabled' } } } }))
  }
  return { args, env, files }
}
