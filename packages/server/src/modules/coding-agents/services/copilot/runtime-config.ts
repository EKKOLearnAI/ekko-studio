import { createScopedRuntimeConfig, type ScopedRuntimeInput, type ScopedRuntimeConfig } from '../runtime/scoped-config'

// Copilot's Anthropic tokenizer only knows canonical Claude model IDs.
// Custom models retain their real ID and use its generic OpenAI BYOK client.
export function copilotScopedUsesChatCompletions(model: string): boolean {
  return !/^claude[-.]/i.test(model.trim())
}

export async function prepareCopilotScopedRuntime(input: ScopedRuntimeInput): Promise<ScopedRuntimeConfig> {
  const { rootDir, model, baseUrl, token, contextWindow, outputLimit, files, json, write } = await createScopedRuntimeConfig(input)
  const usesChatCompletions = copilotScopedUsesChatCompletions(model)
  const env: Record<string, string> = { COPILOT_HOME: rootDir, COPILOT_PROVIDER_TYPE: usesChatCompletions ? 'openai' : 'anthropic', COPILOT_PROVIDER_BASE_URL: baseUrl,
    COPILOT_PROVIDER_API_KEY: token, COPILOT_PROVIDER_MODEL_ID: model, COPILOT_PROVIDER_WIRE_MODEL: model,
    COPILOT_MODEL: model, COPILOT_PROVIDER_MAX_PROMPT_TOKENS: String(contextWindow),
    COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: String(outputLimit), COPILOT_OFFLINE: 'true',
    COPILOT_PROVIDERS_CONFIG: '', COPILOT_PROVIDER_API_KEY_COMMAND: '', COPILOT_PROVIDER_BEARER_TOKEN: '',
    COPILOT_PROVIDER_HEADERS: '', COPILOT_PROVIDER_WIRE_API: usesChatCompletions ? 'completions' : '',
    COPILOT_PROVIDER_TRANSPORT: 'http', COPILOT_GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: '' }
  await write('config', 'config.json', json({ model }))
  const args = ['--model', model]
  return { args, env, files }
}
