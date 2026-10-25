import { mkdir, writeFile, rename, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StudioError, type AgentRuntimeContext, type ModelGatewayHandle } from '@ekko-studio/plugin-sdk'
import { parse, stringify } from 'smol-toml'

export async function scopedCodex(runtime: AgentRuntimeContext, gateway: ModelGatewayHandle) {
  if (!runtime.stateDirectory) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped Codex requires host-managed storage')
  const home = join(runtime.stateDirectory, 'home'), root = join(runtime.stateDirectory, 'codex')
  await mkdir(home, { recursive: true, mode: 0o700 })
  await mkdir(root, { recursive: true, mode: 0o700 })
  const text = await readFile(join(root, 'config.toml'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error })
  let config: import('smol-toml').TomlTable
  try { config = parse(text) } catch { throw new StudioError('INVALID_ARGUMENT', 'Invalid native TOML configuration') }
  const providers = config.model_providers && typeof config.model_providers === 'object' && !Array.isArray(config.model_providers) ? config.model_providers : {}
  const configuration = stringify({ ...config, model: gateway.model, model_provider: 'studio', disable_response_storage: true,
    model_providers: { ...providers, studio: { name: 'Studio', base_url: gateway.baseUrl, wire_api: 'responses', requires_openai_auth: false, env_key: 'STUDIO_NATIVE_MODEL_TOKEN' } } })
  await writeFile(join(root, 'config.toml.tmp'), configuration, { mode: 0o600 })
  await rename(join(root, 'config.toml.tmp'), join(root, 'config.toml'))
  return { HOME: home, USERPROFILE: home, CODEX_HOME: root, STUDIO_NATIVE_MODEL_TOKEN: gateway.token,
    OPENAI_API_KEY: '', OPENAI_BASE_URL: '', CODEX_API_KEY: '' }
}
