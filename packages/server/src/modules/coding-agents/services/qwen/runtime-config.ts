import { join } from 'node:path'
import { createScopedRuntimeConfig, type ScopedRuntimeInput, type ScopedRuntimeConfig } from '../runtime/scoped-config'

export async function prepareQwenScopedRuntime(input: ScopedRuntimeInput): Promise<ScopedRuntimeConfig> {
  const { rootDir, model, baseUrl, token, outputLimit, files, json, write } = await createScopedRuntimeConfig(input)
  const env: Record<string, string> = { QWEN_HOME: rootDir, QWEN_RUNTIME_DIR: join(rootDir, 'runtime'),
    ANTHROPIC_API_KEY: token, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_MODEL: model,
    ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '', OPENAI_BASE_URL: '', OPENAI_MODEL: '' }
  await write('settings', 'settings.json', json({ security: { auth: { selectedType: 'anthropic' } },
    model: { name: model }, modelProviders: { anthropic: [{ id: model, envKey: 'ANTHROPIC_API_KEY', baseUrl,
      generationConfig: { maxOutputTokens: outputLimit } }] } }))
  const args = ['--auth-type', 'anthropic', '--model', model]
  return { args, env, files }
}
