import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { StudioError, type AgentRuntimeContext, type JsonObject, type ModelGatewayHandle } from '@ekko-studio/plugin-sdk'

export const scopedModel = 'ekko-studio/studio-model'

export function inlineConfiguration(config: JsonObject): JsonObject {
  const text = (config.env as Record<string, string> | undefined)?.OPENCODE_CONFIG_CONTENT
  if (!text) return {}
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch { throw new StudioError('INVALID_ARGUMENT', 'Invalid OpenCode inline JSON configuration') }
}

/** Inline runtime overrides leave native settings, plugins, Skills and project files intact. */
export function nativeEnvironment(config: JsonObject): Record<string, string> {
  return { OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...inlineConfiguration(config), autoupdate: false }) }
}

export async function scopedOpenCode(runtime: AgentRuntimeContext, gateway: ModelGatewayHandle, config: JsonObject) {
  if (!runtime.stateDirectory) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped OpenCode requires host-managed storage')
  const home = join(runtime.stateDirectory, 'home'), root = join(runtime.stateDirectory, 'opencode')
  const directories = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'), XDG_CACHE_HOME: join(home, '.cache'), OPENCODE_CONFIG_DIR: root }
  await Promise.all(Object.values(directories).map(path => mkdir(path, { recursive: true, mode: 0o700 })))
  const inline = inlineConfiguration(config)
  return { args: [], env: { ...directories, OPENCODE_DB: join(root, 'opencode.db'), OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_CONFIG: '', OPENCODE_AUTH_JSON: '', STUDIO_OPENCODE_API_KEY: gateway.token,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...inline, autoupdate: false, model: scopedModel, small_model: scopedModel,
      enabled_providers: ['ekko-studio'], provider: { 'ekko-studio': { name: 'Ekko Studio', npm: '@ai-sdk/openai-compatible',
        options: { baseURL: gateway.baseUrl, apiKey: '{env:STUDIO_OPENCODE_API_KEY}' },
        models: { 'studio-model': { id: gateway.model, name: gateway.model, attachment: gateway.images === true, tool_call: true,
          modalities: { input: gateway.images === true ? ['text', 'image'] : ['text'], output: ['text'] },
          limit: { context: config.contextWindow || 131072, output: config.outputLimit || 32768 } } } } } }) } }
}
