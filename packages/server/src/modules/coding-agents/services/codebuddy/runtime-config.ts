import { createHash } from 'node:crypto'
import { createScopedRuntimeConfig, type ScopedRuntimeInput, type ScopedRuntimeConfig } from '../runtime/scoped-config'

export function codebuddyScopedUsesChatCompletions(): boolean { return true }

export async function prepareCodeBuddyScopedRuntime(input: ScopedRuntimeInput): Promise<ScopedRuntimeConfig> {
  const { rootDir, model, baseUrl, token, contextWindow, outputLimit, files, json, write } = await createScopedRuntimeConfig(input)
  // A unique native alias prevents project models.json from replacing this route.
  // The proxy always forwards the selected Studio model, including auxiliary calls.
  const alias = `ekko-scoped-${createHash('sha256').update(rootDir).digest('hex').slice(0, 16)}`
  const env: Record<string, string> = { CODEBUDDY_CONFIG_DIR: rootDir, EKKO_SCOPED_MODEL_TOKEN: token,
    CODEBUDDY_MODEL: alias, CODEBUDDY_SMALL_FAST_MODEL: alias, CODEBUDDY_BIG_SLOW_MODEL: alias,
    CODEBUDDY_CODE_SUBAGENT_MODEL: alias, CODEBUDDY_API_KEY: token, CODEBUDDY_AUTH_TOKEN: '',
    CODEBUDDY_BASE_URL: baseUrl, CODEBUDDY_CUSTOM_HEADERS: '' }
  await write('models', 'models.json', json({ models: [{ id: alias, name: model, vendor: 'Ekko Studio',
    apiKey: '${EKKO_SCOPED_MODEL_TOKEN}', url: `${baseUrl}/chat/completions`,
    maxInputTokens: contextWindow, maxOutputTokens: outputLimit, supportsToolCall: true,
    relatedModels: { lite: alias, reasoning: alias, subagent: alias } }], availableModels: [alias] }))
  await write('settings', 'settings.json', json({ model: alias, variantModels: { lite: alias, reasoning: alias } }))
  const args = ['--model', alias]
  return { args, env, files }
}
