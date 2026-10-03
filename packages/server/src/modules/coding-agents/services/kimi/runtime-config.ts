import { join } from 'node:path'
import { createScopedRuntimeConfig, type ScopedRuntimeInput, type ScopedRuntimeConfig } from '../runtime/scoped-config'

export async function prepareKimiScopedRuntime(input: ScopedRuntimeInput): Promise<ScopedRuntimeConfig> {
  const { rootDir, model, baseUrl, token, contextWindow, outputLimit, files, write } = await createScopedRuntimeConfig(input)
  const args: string[] = []
  const env: Record<string, string> = { KIMI_CODE_HOME: rootDir, KIMI_MODEL_NAME: model, KIMI_MODEL_PROVIDER_TYPE: 'anthropic',
    KIMI_MODEL_BASE_URL: baseUrl, KIMI_MODEL_API_KEY: token,
    KIMI_MODEL_MAX_CONTEXT_SIZE: String(contextWindow), KIMI_MODEL_MAX_OUTPUT_SIZE: String(outputLimit),
    KIMI_MODEL_CAPABILITIES: '', KIMI_MODEL_THINKING_EFFORT: '', KIMI_MODEL_ADAPTIVE_THINKING: 'false',
    KIMI_MODEL_THINKING_KEEP: 'none', KIMI_CUSTOM_HEADERS: '', KIMI_DISABLE_TELEMETRY: '1' }
  // The documented KIMI_MODEL_* override is in-memory; credentials are not persisted.
  await write('config', 'config.toml', '# Model and local proxy credentials are supplied by the session environment.\n')
  return { args, env, files }
}
