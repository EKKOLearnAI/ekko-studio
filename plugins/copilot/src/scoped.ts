import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StudioError, type AgentRuntimeContext, type ModelGatewayHandle, type ModelGatewayInput, type JsonObject } from '@ekko-studio/plugin-sdk'

// Anthropic's native tokenizer requires a canonical Claude ID; other names use generic OpenAI BYOK.
export function copilotProtocol(model: string): ModelGatewayInput['protocol'] {
  return /^claude[-.]/i.test(model.split('/').at(-1)?.trim() || '') ? 'anthropic' : 'chat-completions'
}
export async function scopedCopilot(runtime: AgentRuntimeContext, gateway: ModelGatewayHandle, config: JsonObject) {
  if (!runtime.stateDirectory) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped Copilot requires host-managed storage')
  const home = join(runtime.stateDirectory, 'home'), root = join(runtime.stateDirectory, 'copilot')
  await mkdir(home, { recursive: true, mode: 0o700 }); await mkdir(root, { recursive: true, mode: 0o700 })
  const chat = gateway.protocol === 'chat-completions', model = chat ? gateway.model : gateway.model.split('/').at(-1)!
  const path = join(root, 'settings.json'), text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return '{}'; throw error })
  let settings: JsonObject
  try { settings = JSON.parse(text); if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error() }
  catch { throw new StudioError('INVALID_ARGUMENT', 'Invalid Copilot JSON configuration') }
  await writeFile(`${path}.tmp`, JSON.stringify({ ...settings, model }), { mode: 0o600 }); await rename(`${path}.tmp`, path)
  return { args: ['--model', model], env: { HOME: home, USERPROFILE: home, COPILOT_HOME: root,
    COPILOT_PROVIDER_TYPE: chat ? 'openai' : 'anthropic', COPILOT_PROVIDER_BASE_URL: chat ? gateway.baseUrl : gateway.baseUrl.replace(/\/v1$/, ''), COPILOT_PROVIDER_API_KEY: gateway.token,
    COPILOT_PROVIDER_MODEL_ID: model, COPILOT_PROVIDER_WIRE_MODEL: model, COPILOT_MODEL: model,
    COPILOT_PROVIDER_MAX_PROMPT_TOKENS: String(config.contextWindow || 131072), COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: String(config.outputLimit || 32768),
    COPILOT_OFFLINE: 'true', COPILOT_PROVIDERS_CONFIG: '', COPILOT_PROVIDER_API_KEY_COMMAND: '', COPILOT_PROVIDER_BEARER_TOKEN: '',
    COPILOT_PROVIDER_HEADERS: '', COPILOT_PROVIDER_WIRE_API: chat ? 'completions' : '', COPILOT_PROVIDER_TRANSPORT: 'http',
    COPILOT_GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: '' } }
}
