import { mkdir, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { StudioError, type AgentRuntimeContext, type ModelGatewayHandle } from '@ekko-studio/plugin-sdk'

export async function scopedCodex(runtime: AgentRuntimeContext, gateway: ModelGatewayHandle) {
  if (!runtime.stateDirectory) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped Codex requires host-managed storage')
  const home = join(runtime.stateDirectory, 'home'), root = join(runtime.stateDirectory, 'codex')
  await mkdir(home, { recursive: true, mode: 0o700 })
  await mkdir(root, { recursive: true, mode: 0o700 })
  const configuration = `model = ${JSON.stringify(gateway.model)}\nmodel_provider = "studio"\n` +
    (gateway.transport === 'translated' ? 'web_search = "disabled"\n' : '') +
    `disable_response_storage = true\n[model_providers.studio]\nname = "Studio"\nbase_url = ${JSON.stringify(gateway.baseUrl)}\n` +
    'wire_api = "responses"\nrequires_openai_auth = false\nenv_key = "STUDIO_NATIVE_MODEL_TOKEN"\n'
  await writeFile(join(root, 'config.toml.tmp'), configuration, { mode: 0o600 })
  await rename(join(root, 'config.toml.tmp'), join(root, 'config.toml'))
  return { HOME: home, USERPROFILE: home, CODEX_HOME: root, STUDIO_NATIVE_MODEL_TOKEN: gateway.token,
    OPENAI_API_KEY: '', OPENAI_BASE_URL: '', CODEX_API_KEY: '' }
}
