import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StudioError, type AgentRuntimeContext, type ModelGatewayHandle, type JsonObject } from '@ekko-studio/plugin-sdk'

/** Kimi's documented in-memory provider override keeps temporary credentials out of config.toml. */
export async function scopedKimi(runtime: AgentRuntimeContext, gateway: ModelGatewayHandle, config: JsonObject) {
  if (!runtime.stateDirectory) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped Kimi requires host-managed storage')
  const home = join(runtime.stateDirectory, 'home'), root = join(runtime.stateDirectory, 'kimi')
  await mkdir(home, { recursive: true, mode: 0o700 }); await mkdir(root, { recursive: true, mode: 0o700 })
  await writeFile(join(root, 'config.toml'), '# Model and temporary credentials are supplied by the session environment.\n', { mode: 0o600, flag: 'wx' })
    .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
  return { args: [], env: {
    HOME: home, USERPROFILE: home, KIMI_CODE_HOME: root, KIMI_MODEL_NAME: gateway.model, KIMI_MODEL_PROVIDER_TYPE: 'anthropic',
    KIMI_MODEL_BASE_URL: gateway.baseUrl, KIMI_MODEL_API_KEY: gateway.token,
    KIMI_MODEL_MAX_CONTEXT_SIZE: String(config.contextWindow || 131072), KIMI_MODEL_MAX_OUTPUT_SIZE: String(config.outputLimit || 32768),
    KIMI_MODEL_CAPABILITIES: gateway.images === true ? 'image_in' : '', KIMI_MODEL_THINKING_EFFORT: String(config.reasoningEffort || ''),
    KIMI_MODEL_ADAPTIVE_THINKING: 'false', KIMI_MODEL_THINKING_KEEP: 'none', KIMI_CUSTOM_HEADERS: '', KIMI_CODE_CUSTOM_HEADERS: '', KIMI_DISABLE_TELEMETRY: '1',
  } }
}
