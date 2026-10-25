import { mkdir, writeFile, rename, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StudioError, type AgentRuntimeContext, type ModelGatewayHandle } from '@ekko-studio/plugin-sdk'

export async function scopedQwen(runtime: AgentRuntimeContext, gateway: ModelGatewayHandle) {
  if (!runtime.stateDirectory) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped Qwen requires host-managed storage')
  const baseUrl = gateway.baseUrl.replace(/\/v1$/, '')
  const home = join(runtime.stateDirectory, 'home'), root = join(runtime.stateDirectory, 'qwen')
  await mkdir(home, { recursive: true, mode: 0o700 })
  await mkdir(root, { recursive: true, mode: 0o700 })
  const text = await readFile(join(root, 'settings.json'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return '{}'; throw error })
  let config: Record<string, any>
  try { config = JSON.parse(text); if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error() }
  catch { throw new StudioError('INVALID_ARGUMENT', 'Invalid native JSON configuration') }
  await writeFile(join(root, 'settings.json.tmp'), JSON.stringify({ ...config, security: { ...config.security, auth: { ...config.security?.auth, selectedType: 'anthropic' } }, model: { ...config.model, name: gateway.model },
    modelProviders: { ...config.modelProviders, anthropic: [{ id: gateway.model, generationConfig: { modalities: { image: gateway.images === true } }, envKey: 'ANTHROPIC_API_KEY', baseUrl }] } }), { mode: 0o600 })
  await rename(join(root, 'settings.json.tmp'), join(root, 'settings.json'))
  return { args: ['--auth-type', 'anthropic', '--model', gateway.model], env: {
    HOME: home, USERPROFILE: home, QWEN_HOME: root, QWEN_RUNTIME_DIR: join(root, 'runtime'),
    ANTHROPIC_API_KEY: gateway.token, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_MODEL: gateway.model,
    ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '', OPENAI_BASE_URL: '', OPENAI_MODEL: '',
  } }
}
